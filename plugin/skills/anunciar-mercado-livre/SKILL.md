---
name: anunciar-mercado-livre
description: Criar ou editar anúncio da JadyponHidro no Mercado Livre pela API (ferramentas do servidor mercadolivre), completo de primeira, sem nada em branco. Use quando o usuário pedir para anunciar, publicar, duplicar, corrigir ou completar um anúncio no Mercado Livre.
---

# Anunciar no Mercado Livre — padrão JadyponHidro

Tudo é feito pelas ferramentas do servidor `mercadolivre` (API oficial), nunca pelo navegador. O objetivo é que o anúncio saia **completo de primeira**: descrição, todas as características, garantia, SKU, fotos, variações e frete. Ninguém deve precisar entrar no site depois para completar.

## Regras que não mudam

- **Nunca inventar dado.** Custo, estoque, medida, peso, marca, material, norma e pressão vêm só das fontes: UpSeller, planilha NOVA ERA, fornecedor ou a mensagem do usuário. Se faltar algo, pare e pergunte, listando todas as pendências de uma vez. Dado que já foi dito antes na conversa, ou que está no UpSeller, não se pergunta de novo.
- **Nunca deixar descrição ou característica em branco.** Se uma característica não tiver dado confirmado, pergunte em vez de pular.
- **Sem pedir confirmação.** Quando o usuário passa um produto, é ordem para anunciar: publique o anúncio completo de uma vez, sem mostrar prévia e sem perguntar "posso publicar?". O mesmo vale para editar, ligar Flex, atacado e catálogo. A única exceção é dado que realmente falta (veja a primeira regra): aí pare e liste tudo de uma vez. No fim, mostre só o link e o que ficou pendente.
- **Linguagem simples com o usuário.** Termo técnico só com explicação de uma frase.
- **Não anunciar** produtos da marca Tigre, nem caixas d'água, tanques e itens muito grandes (dependem de ME1).

## Padrões do anúncio

- **Tipo:** Clássico (`gold_special`). A exceção são as caixas d'água, que vão em Premium (`gold_pro`).
- **Garantia:** de fábrica, 3 meses. Use `warranty_type: "Garantia de fábrica"` e `warranty_time: "3 meses"`.
- **Retirada:** oferece retirada pessoalmente (no `shipping`, `local_pick_up: true`).
- **Flex:** quando o produto vai no Flex, passe `flex: true` no `create_item` (ou use `set_flex`). No preço, some os R$ 3 que ele paga por venda no Flex.
- **Atacado:** sempre coloque preço de atacado (`wholesale` no `create_item`, ou `set_wholesale_prices`). O desconto depende do lucro: pergunte as faixas se ele não disser (já usou 3+ = 5% e 6+ = 8%, e 3+ = 5% e 5+ = 10%). Em todas as faixas tem que sobrar lucro. Se o Mercado Livre der aviso numa faixa, tire essa faixa em vez de forçar.
- **Título:**
  - Kits e caixas fechadas começam pela quantidade total. Exemplo: "1500 Pregos 18x30 Caixa Fechada…", ou "Kit 10 Joelhos…".
  - Galvanizados seguem o modelo "[Peça] [Ângulo/Tipo] Galvanizado [Medida] Rosca BSP [Fêmea/Macho] - Segurimax". A marca deles é Segurimax, nunca "Sem marca".
  - O título respeita o limite da categoria (`max_title_length`).
- **Variações:** um único anúncio com variações por medida, nunca um anúncio por medida. O estoque de cada variação é o valor exato da fonte, e variações com estoque 0 continuam no anúncio.
- **Descrição:** texto puro, em tom de fornecedor técnico, nesta ordem:
  1. Abertura no formato "[Produto] – [rosca/medida] – [marca]".
  2. Um parágrafo sobre o uso prático.
  3. Um parágrafo sobre material, acabamento e indicação.
  4. ESPECIFICAÇÕES TÉCNICAS, no formato "Campo: valor" (Produto, Medidas disponíveis, Tipo de rosca, Material, Acabamento, Classe, Marca).

  Sem emojis, sem exagero de marketing e sem prometer norma, certificação ou pressão que a fonte não confirme.
- **SKU:** sempre preencher `seller_sku` com o código do produto no UpSeller. É por ele que o UpSeller liga o anúncio ao estoque.
- **Pesos e medidas:**
  - No UpSeller ficam em gramas; no Mercado Livre vão em quilos.
  - Arredonde sempre para cima e confira a unidade (cm ou m, kg ou g).
  - Os campos de embalagem aparecem como características em `get_category_attributes` e também devem ser preenchidos.
- **Embalagem:** sempre passe `package` (altura, largura e comprimento em cm, peso em gramas, tirados do UpSeller). O Mercado Livre não publica sem isso.
- **Catálogo:** se o produto existir no catálogo, depois de publicar chame `create_catalog_listing`.
- **Fotos:** ficam na pasta "foto de produtos" do computador. Use `photos_folder` com o SKU (ex.: "9003") e o conector sobe todas as imagens da pasta direto do disco, em ordem de nome. Se o usuário citar nomes de arquivo, passe os nomes em `pictures`. Nunca peça para mandar foto pelo chat nem baixe foto para o chat: isso gasta muito. A primeira foto mostra o produto de pé. As fotos de cada variação vão na variação certa.

## Preço

O usuário informa o lucro a cada anúncio. Calcule pela fórmula:

preço = (custo + lucro + custo fixo do ML + entrega) / (1 − tarifa% do ML − 0,06)

- A **tarifa** vem de `get_listing_prices` com a categoria e o tipo de anúncio. Nunca use valor de memória.
- No **envio Flex**, some R$ 3 por venda.
- Se o produto for **kit ou caixa**, o custo é o custo unitário vezes a quantidade.
- Mostre uma tabela por variação com: custo | lucro | tarifa ML | custo fixo | entrega | NF 6% | preço final.

## Economizar tokens

- Em `get_category_attributes`, as listas de opções vêm curtas (25). Para achar uma opção específica, use `value_filter` em vez de aumentar `max_values`.
- Não rode `check_listing_quality` depois do `create_item`/`update_item`: o resultado já diz se está completo e o que falta.
- **Atalho por categoria:** na primeira vez de uma categoria, leia `get_category_attributes` e guarde com `save_category_preset` as características fixas (tipo de montagem, acabamento etc.). Nas próximas, passe `preset` no `create_item` e pule a leitura da categoria; só envie o que muda por produto (marca, modelo, medida, GTIN).
- Passe `catalog_product_id` no `create_item` para ligar ao catálogo na mesma chamada.
- Não abra o UpSeller pelo Chrome se o usuário já mandou os dados ou uma planilha exportada.
- Não repita o anúncio inteiro no chat. Resposta final: link, preço, e o que ficou pendente.

## Passo a passo para criar

1. **Categoria:** use `predict_category` com o título e confirme com `get_category`. Se o produto existir no catálogo e for o mesmo produto, prefira anunciar no catálogo (`search_catalog`, depois `create_catalog_listing`).
2. **Características:** rode `get_category_attributes`. Preencha **todas** as que tiverem `fillable: true`, não só as obrigatórias. Para listas fechadas, use o `value_id` (filtre com `value_filter`). Veja também os `sale_terms` da categoria.
3. **Fotos:** `photos_folder` com o SKU. Não precisa de `upload_picture`.
4. **Publicar:** chame `create_item` uma única vez, passando tudo: `photos_folder`, `preset` (se houver), `catalog_product_id`, `flex` e `wholesale`. A ferramenta recusa o envio se faltar característica obrigatória e devolve a lista do que falta.
5. **Conferir:** o resultado traz `complete`. Se for falso, corrija o que consta em `missing` com `update_item`, sem perguntar, até não sobrar nada vazio.
6. **Resposta ao usuário:** link do anúncio, preço, atacado e o que ficou pendente. Nada além disso.
7. **UpSeller:** registre o produto no UpSeller. Todo produto precisa estar nos dois lugares.

## Editar ou completar um anúncio

- Use `check_listing_quality` para ver o que falta.
- Use `update_item` para corrigir qualquer parte: descrição, fotos, características, garantia, SKU, frete, variações, preço, estoque ou tipo de anúncio.
- Altere direto o que o usuário pediu, sem pedir autorização de novo, e conte o que mudou em uma linha.

## Se a conta não estiver conectada

Chame `connect_account`. Na primeira vez, ela abre no navegador uma página do próprio computador onde o usuário digita o App ID e o Client Secret. **Nunca peça esses dados no chat.** Em seguida, abre a página do Mercado Livre, e o usuário só entra na conta e clica em permitir.
