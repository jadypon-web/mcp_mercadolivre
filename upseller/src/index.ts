import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Plugin do UpSeller para quem NÃO tem a API (plano Inicial): monta a planilha
// de importação de produtos no modelo do próprio UpSeller. O usuário só
// importa o arquivo em Produtos do Armazém > Importar.

const HOME = path.join(os.homedir(), ".upseller-planilha");
const CONFIG = path.join(HOME, "config.json");

type Config = { modelo?: string; ultimo_sku?: number };

function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(c: Config) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1));
}

const text = (o: unknown) => ({
  content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `Erro: ${(e as Error).message}` }],
});

// --- Campos conhecidos e como as colunas do modelo costumam se chamar -------

type Campo =
  | "sku" | "titulo" | "custo" | "preco_varejo" | "peso_g" | "comprimento_cm"
  | "largura_cm" | "altura_cm" | "gtin" | "ncm" | "cest" | "origem" | "fornecedor"
  | "link_fornecedor" | "imagem" | "categoria" | "apelido" | "estoque" | "marca";

// Termos (já sem acento e minúsculos) que identificam cada campo no cabeçalho.
const SINONIMOS: Record<Campo, string[]> = {
  sku: ["sku"],
  titulo: ["titulo do produto", "nome do produto", "titulo", "nome"],
  custo: ["custo de compra", "preco de custo", "custo"],
  preco_varejo: ["preco de varejo", "preco de venda", "preco"],
  peso_g: ["peso"],
  comprimento_cm: ["comprimento", "profundidade"],
  largura_cm: ["largura"],
  altura_cm: ["altura"],
  gtin: ["codigo de barras", "gtin", "ean", "barcode", "upc"],
  ncm: ["ncm"],
  cest: ["cest"],
  origem: ["origem"],
  fornecedor: ["fornecedor"],
  link_fornecedor: ["link do fornecedor", "link de origem", "url do fornecedor", "link da fonte", "link"],
  imagem: ["imagem", "foto"],
  categoria: ["categoria"],
  apelido: ["apelido"],
  estoque: ["estoque inicial", "estoque"],
  marca: ["marca"],
};

// Ordem de teste: nomes mais específicos primeiro, para "link do fornecedor" não
// ser tomado como "fornecedor" e "preço de custo" não ser tomado como "preço".
const ORDEM: Campo[] = [
  "link_fornecedor", "custo", "preco_varejo", "titulo", "comprimento_cm", "largura_cm",
  "altura_cm", "peso_g", "gtin", "ncm", "cest", "origem", "fornecedor", "imagem",
  "categoria", "apelido", "estoque", "marca", "sku",
];

function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[*:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((t) => t.text).join("");
    if (typeof o.text === "string") return o.text;
    if (o.result !== undefined) return String(o.result);
    return "";
  }
  return String(v);
}

function campoDoCabecalho(h: string): Campo | undefined {
  const n = norm(h);
  if (!n) return undefined;
  // Unidade entre parênteses não atrapalha: "Peso (g)" -> "peso".
  const semParenteses = n.replace(/\(.*?\)/g, "").trim();
  for (const campo of ORDEM) {
    for (const termo of SINONIMOS[campo]) {
      if (semParenteses === termo || semParenteses.startsWith(termo) || n.includes(termo)) {
        if (campo === "sku" && semParenteses.includes("sku") && /(loja|anuncio|pai|spu)/.test(semParenteses)) continue;
        return campo;
      }
    }
  }
  return undefined;
}

type Mapa = { ws: ExcelJS.Worksheet; linhaCab: number; colunas: Map<Campo, number>; naoMapeadas: string[]; todas: string[] };

function acharCabecalho(wb: ExcelJS.Workbook, aba?: string): Mapa {
  const abas = aba ? wb.worksheets.filter((w) => w.name === aba) : wb.worksheets;
  if (abas.length === 0) throw new Error(`Aba "${aba}" não existe no modelo.`);
  let melhor: Mapa | undefined;
  for (const ws of abas) {
    for (let r = 1; r <= Math.min(12, ws.rowCount); r++) {
      const colunas = new Map<Campo, number>();
      const todas: string[] = [];
      const naoMapeadas: string[] = [];
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
        const t = cellText(cell.value).trim();
        if (!t) return;
        todas.push(t);
        const campo = campoDoCabecalho(t);
        if (campo && !colunas.has(campo)) colunas.set(campo, col);
        else naoMapeadas.push(t);
      });
      if (!melhor || colunas.size > melhor.colunas.size) {
        melhor = { ws, linhaCab: r, colunas, naoMapeadas, todas };
      }
    }
  }
  if (!melhor || melhor.colunas.size < 2) {
    throw new Error("Não reconheci as colunas desse modelo. Use modelo_colunas para ver os cabeçalhos.");
  }
  return melhor;
}

async function abrir(modelo: string): Promise<ExcelJS.Workbook> {
  if (!fs.existsSync(modelo)) throw new Error(`Modelo não encontrado: ${modelo}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(modelo);
  return wb;
}

function resolverModelo(modelo?: string): string {
  const m = modelo ?? readConfig().modelo;
  if (!m) {
    throw new Error("Informe o caminho do modelo de planilha do UpSeller (modelo). Ele fica guardado para as próximas vezes.");
  }
  return m.startsWith("~") ? path.join(os.homedir(), m.slice(1)) : m;
}

// --- Servidor --------------------------------------------------------------

const server = new McpServer({ name: "upseller-planilha", version: "0.1.0" });

server.registerTool(
  "modelo_colunas",
  {
    description:
      "Lê o modelo de planilha de importação do UpSeller (arquivo .xlsx baixado em Produtos do Armazém > Importar) e mostra as abas, a linha de cabeçalho, quais colunas foram reconhecidas e quais não. Guarda o caminho do modelo para as próximas vezes. Use na primeira vez ou quando o UpSeller mudar o modelo.",
    inputSchema: {
      modelo: z.string().optional().describe("Caminho do .xlsx do modelo; se omitido, usa o último guardado"),
      aba: z.string().optional().describe("Nome da aba (padrão: a que tiver mais colunas reconhecidas)"),
    },
  },
  async ({ modelo, aba }) => {
    try {
      const caminho = resolverModelo(modelo);
      const wb = await abrir(caminho);
      const m = acharCabecalho(wb, aba);
      writeConfig({ ...readConfig(), modelo: caminho });
      return text({
        abas: wb.worksheets.map((w) => w.name),
        aba_usada: m.ws.name,
        linha_cabecalho: m.linhaCab,
        reconhecidas: Object.fromEntries([...m.colunas].map(([c, i]) => [c, m.ws.getRow(m.linhaCab).getCell(i).text])),
        nao_reconhecidas: m.naoMapeadas,
        linhas_abaixo_do_cabecalho: Math.max(0, m.ws.rowCount - m.linhaCab),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

const produto = z.object({
  sku: z.string().describe("Código interno do produto (único no UpSeller; não dá para mudar depois)"),
  titulo: z.string().describe("Título do produto"),
  custo: z.number().describe("Custo de compra unitário em reais (da fonte: NOVA ERA, Eletroleste, Casa Mimosa...)"),
  peso_g: z.number().describe("Peso em gramas (no UpSeller é sempre em gramas)"),
  comprimento_cm: z.number(),
  largura_cm: z.number(),
  altura_cm: z.number(),
  gtin: z.string().optional().describe("Código de barras (EAN/GTIN) real; não inventar"),
  ncm: z.string().optional(),
  cest: z.string().optional(),
  origem: z.string().optional().describe("Origem da mercadoria, como aparece na lista do modelo"),
  fornecedor: z.string().optional(),
  link_fornecedor: z.string().optional(),
  imagem: z.string().optional().describe("Link da imagem principal"),
  categoria: z.string().optional(),
  apelido: z.string().optional(),
  marca: z.string().optional(),
  estoque: z.number().optional().describe("Estoque inicial"),
  preco_varejo: z.number().optional(),
});

server.registerTool(
  "gerar_planilha",
  {
    description:
      "Preenche o modelo de importação do UpSeller com os produtos e salva um arquivo novo (o modelo original não é alterado). Antes de gravar, confere o que falta: sku, titulo, custo, peso e as 3 medidas são obrigatórios; se algum produto estiver incompleto, NADA é gerado e a resposta lista as pendências de todos de uma vez. Devolve o caminho do arquivo para o usuário importar em Produtos do Armazém > Importar. Nunca invente valores para completar um produto.",
    inputSchema: {
      produtos: z.array(produto).min(1).max(200),
      modelo: z.string().optional().describe("Caminho do .xlsx do modelo; se omitido, usa o guardado por modelo_colunas"),
      aba: z.string().optional(),
      pasta_saida: z.string().optional().describe("Pasta onde salvar (padrão: a pasta do modelo)"),
    },
  },
  async ({ produtos, modelo, aba, pasta_saida }) => {
    try {
      const caminho = resolverModelo(modelo);

      const pendencias: string[] = [];
      const skus = new Set<string>();
      for (const p of produtos) {
        const falta: string[] = [];
        if (!p.sku.trim()) falta.push("sku");
        if (!p.titulo.trim()) falta.push("titulo");
        if (!(p.custo > 0)) falta.push("custo");
        if (!(p.peso_g > 0)) falta.push("peso");
        if (!(p.comprimento_cm > 0)) falta.push("comprimento");
        if (!(p.largura_cm > 0)) falta.push("largura");
        if (!(p.altura_cm > 0)) falta.push("altura");
        if (skus.has(p.sku)) falta.push("sku repetido na lista");
        skus.add(p.sku);
        if (falta.length) pendencias.push(`${p.sku || p.titulo || "?"}: ${falta.join(", ")}`);
      }
      if (pendencias.length) {
        return text({ gerado: false, pendencias });
      }

      const wb = await abrir(caminho);
      const m = acharCabecalho(wb, aba);

      // Primeira linha livre abaixo do cabeçalho (ignora linhas vazias).
      let linha = m.linhaCab + 1;
      while (linha <= m.ws.rowCount && m.ws.getRow(linha).hasValues) linha++;

      const semColuna = new Set<string>();
      for (const p of produtos) {
        const row = m.ws.getRow(linha);
        const valores: Record<Campo, unknown> = {
          sku: p.sku,
          titulo: p.titulo,
          custo: p.custo,
          preco_varejo: p.preco_varejo,
          peso_g: p.peso_g,
          comprimento_cm: p.comprimento_cm,
          largura_cm: p.largura_cm,
          altura_cm: p.altura_cm,
          gtin: p.gtin,
          ncm: p.ncm,
          cest: p.cest,
          origem: p.origem,
          fornecedor: p.fornecedor,
          link_fornecedor: p.link_fornecedor,
          imagem: p.imagem,
          categoria: p.categoria,
          apelido: p.apelido,
          estoque: p.estoque,
          marca: p.marca,
        };
        for (const [campo, valor] of Object.entries(valores) as Array<[Campo, unknown]>) {
          if (valor === undefined || valor === "") continue;
          const col = m.colunas.get(campo);
          if (!col) {
            semColuna.add(campo);
            continue;
          }
          // Textos que parecem número (SKU, GTIN, NCM) ficam como texto.
          row.getCell(col).value = typeof valor === "number" ? valor : String(valor);
        }
        row.commit();
        linha++;
      }

      const pasta = pasta_saida
        ? pasta_saida.startsWith("~") ? path.join(os.homedir(), pasta_saida.slice(1)) : pasta_saida
        : path.dirname(caminho);
      fs.mkdirSync(pasta, { recursive: true });
      const agora = new Date();
      const carimbo = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(agora.getDate()).padStart(2, "0")}_${String(agora.getHours()).padStart(2, "0")}${String(agora.getMinutes()).padStart(2, "0")}`;
      const saida = path.join(pasta, `importar-upseller_${carimbo}.xlsx`);
      await wb.xlsx.writeFile(saida);
      writeConfig({ ...readConfig(), modelo: caminho });

      return text({
        gerado: true,
        arquivo: saida,
        produtos: produtos.length,
        aba: m.ws.name,
        campos_sem_coluna_no_modelo: [...semColuna],
        proximo_passo: "Importar em Produtos do Armazém > Importar > Produto único.",
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "proximo_sku",
  {
    description:
      "Entrega o próximo código SKU numérico livre (contador guardado no computador) e avança o contador. Use definir_ultimo_sku se o UpSeller já tiver SKUs maiores que o contador. Com quantidade > 1 devolve uma lista seguida.",
    inputSchema: { quantidade: z.number().int().min(1).max(200).optional() },
  },
  async ({ quantidade }) => {
    try {
      const c = readConfig();
      if (c.ultimo_sku === undefined) {
        return fail(new Error("Contador não definido. Chame definir_ultimo_sku com o maior SKU numérico que já existe no UpSeller."));
      }
      const n = quantidade ?? 1;
      const lista = Array.from({ length: n }, (_, i) => String(c.ultimo_sku! + 1 + i));
      writeConfig({ ...c, ultimo_sku: c.ultimo_sku + n });
      return text({ skus: lista });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "definir_ultimo_sku",
  {
    description: "Define o maior SKU numérico que já existe no UpSeller (o próximo será este + 1). Só confira com o usuário ou com a lista do UpSeller; não chute.",
    inputSchema: { ultimo_sku: z.number().int().min(0) },
  },
  async ({ ultimo_sku }) => {
    writeConfig({ ...readConfig(), ultimo_sku });
    return text({ ultimo_sku });
  }
);

await server.connect(new StdioServerTransport());
