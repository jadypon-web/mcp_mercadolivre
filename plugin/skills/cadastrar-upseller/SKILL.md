---
name: cadastrar-upseller
description: Cadastrar produtos no UpSeller (Produtos do Armazém) a partir só do título ou do anúncio do Mercado Livre, gerando a planilha de importação. Use quando o usuário mandar títulos para registrar no UpSeller.
---

# Cadastrar no UpSeller (plano sem API): planilha de importação

O usuário importa o arquivo em Produtos do Armazém › Importar. Nunca preencha o formulário do UpSeller pelo navegador (gasta muito token). Sem pedir confirmação: receba o título, faça e entregue o arquivo. Pare só se faltar dado obrigatório (sku, título, custo, peso, 3 medidas); liste todas as pendências de todos os produtos juntas. Nunca invente dado; o que veio de pesquisa, avise. Peso em gramas e medidas em cm, sempre arredondando para cima.

## Menos token (siga na ordem)
1. **Produto já anunciado no Mercado Livre:** `dados_para_upseller` (conector do Mercado Livre) devolve sku, título, GTIN, marca, peso, medidas e foto de uma vez. **Não pesquise de novo** o que já veio daí.
2. **Produto ainda sem anúncio:** use o catálogo do ML (`search_catalog`; `get_catalog_product` sem `full`), depois uma busca na internet. Uma busca por dado faltante, todas juntas e em paralelo.
3. **Custo:** só da fonte que o usuário indicar (NOVA ERA, Eletroleste, Casa Mimosa). Não indicou: pergunte uma vez para todos os produtos.
4. **NCM/CEST:** pesquise **uma vez por tipo de produto** e grave com `guardar_fiscal`. Depois basta passar `tipo` em `gerar_planilha`. Sem certeza, não grave e deixe em branco.
5. **Valores fixos** (fornecedor, origem, estoque inicial, categoria): `definir_padroes` uma vez; não repita nos produtos.
6. Cadastre vários produtos numa única chamada de `gerar_planilha`.

## Passo a passo
1. Primeira vez: `modelo_colunas` com o caminho do modelo baixado em Importar (fica guardado) e `definir_ultimo_sku` com o maior SKU numérico existente. Depois: `proximo_sku`.
2. Reúna os dados (ordem acima) e chame `gerar_planilha` uma vez.
3. Resposta curta: caminho do arquivo, uma linha por produto (SKU, título, custo) e só o que veio de pesquisa ou ficou em branco. O SKU do anúncio do Mercado Livre deve ser o mesmo do UpSeller.

Ficha: em `gerar_planilha`, envie também `descricao` (completa, sem nada em branco), `marca` e `caracteristicas` de cada produto. Ficam guardadas por SKU (tool `ficha`) para o anúncio no Mercado Livre. Dado exato não achado: use o de produto parecido, sem perguntar.
