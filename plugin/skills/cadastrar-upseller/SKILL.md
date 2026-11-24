---
name: cadastrar-upseller
description: Cadastrar produtos no UpSeller (Produtos do Armazém) a partir só do título do produto — pesquisa os dados e monta a planilha de importação. Use quando o usuário mandar um ou mais títulos de produto para registrar no UpSeller.
---

# Cadastrar produto no UpSeller a partir do título

O plano do usuário no UpSeller (Inicial) não tem API. Por isso o cadastro é feito por **planilha de importação**: o Claude pesquisa os dados, gera o arquivo com a ferramenta `gerar_planilha` (servidor `upseller-planilha`) e o usuário só importa em **Produtos do Armazém › Importar**. Nunca use o navegador para preencher o formulário do UpSeller: gasta muito token.

## O que o usuário manda
Só o título do produto (pode vir uma lista). Se ele disser de onde vem o custo, use essa fonte. Se não disser, pergunte uma vez, para todos os produtos juntos.

## Regras
- **Sem confirmação.** Recebeu o título, faça tudo e entregue o arquivo. Pare só se faltar um dado obrigatório que não se acha em nenhuma fonte: liste todas as pendências de todos os produtos de uma vez.
- **Nunca inventar.** Custo, peso, medidas e código de barras vêm de fonte. Pesquisa com IA ou na internet é permitida quando falta dado, mas diga na resposta o que veio de pesquisa (não é exato). Se não achar, deixe em branco (opcionais) ou pergunte (obrigatórios).
- **Unidades:** peso em **gramas**, medidas em **cm**. Arredonde sempre para cima. Confira a unidade da fonte (kg → g, mm → cm, m → cm).
- **Português, linguagem simples.**

## Onde buscar cada dado (nesta ordem)
1. **Custo:** a fonte que o usuário indicar: planilha NOVA ERA (coluna CUSTO) se tem em estoque; Eletroleste (site logado no Chrome dele), Casa Mimosa (casamimosa.com.br) ou outro fornecedor. Nunca pesquisar custo na internet em geral.
2. **Código de barras, peso e medidas, marca:** catálogo do Mercado Livre pelo conector (`search_catalog`, depois `get_catalog_product`); depois site do fabricante ou da loja; por último pesquisa na internet. Se duas fontes discordarem, use a maior medida e avise.
3. **NCM e CEST:** quase nunca estão no sistema nem nos fornecedores. Pesquise (busca rápida na internet) e avise que veio de pesquisa. Sem certeza, deixe em branco.
4. **Foto:** link da imagem principal só se achar uma que combine com o produto; senão deixe em branco.

## Passo a passo
1. Na primeira vez, `modelo_colunas` com o caminho do modelo baixado em Produtos do Armazém › Importar (ele fica guardado). Se o UpSeller mudar o modelo, rode de novo.
2. SKU: use `proximo_sku` (com a quantidade de produtos). Na primeira vez, descubra o maior SKU numérico já existente e grave com `definir_ultimo_sku`.
3. Pesquise todos os produtos juntos (buscas em paralelo), para gastar menos.
4. Chame `gerar_planilha` **uma vez** com todos os produtos.
5. Responda curto: o caminho do arquivo, uma linha por produto (SKU, título, custo) e, se houver, o que veio de pesquisa ou ficou em branco. Lembre que o SKU de cada anúncio do Mercado Livre deve ser o mesmo do UpSeller.

## Se o Mercado Livre já tem o anúncio
Se o produto já foi anunciado pelo conector, use o mesmo SKU do anúncio (`seller_sku`) no cadastro, para o UpSeller poder mapear.
