---
name: cadastrar-upseller
description: Cadastrar produto no UpSeller (Produtos do Armazém) preenchendo o formulário direto no Chrome do usuário, a partir só do nome/título do produto. Use quando o usuário mandar um produto para registrar no UpSeller.
---

# Cadastrar no UpSeller: preencher o formulário no Chrome

NÃO gerar planilha de importação (o usuário testou e não quer). O cadastro é feito preenchendo o formulário de produto do UpSeller no Chrome dele (Claude in Chrome, conta jadypon@gmail.com), em Produtos do Armazém › Adicionar produto.

## Regras
- Sem perguntar e sem pedir confirmação: receba o nome do produto, pesquise, preencha e salve. Só pare se for impossível achar o dado depois de pesquisar bastante.
- Nunca deixe campo em branco. Não achou o dado exato: pesquise mais; se ainda assim não achar, use o de produto parecido da mesma linha (e avise no fim qual dado veio de parecido).
- Nada de fotos (o usuário coloca depois).
- Pouco token: leia a página com `read_page`/`find` e preencha com `form_input`; evite screenshots e clique por clique. Use screenshot só para conferir no fim.

## Campos a preencher
SKU, título, categoria, código de barras (GTIN), custo de compra, descrição, marca, peso do pacote (g), tamanho da embalagem (C x L x A em cm), NCM, CEST.
- **SKU:** número que NÃO exista no sistema (confira na lista de produtos; qualquer número serve, preferência pelos menores livres). Deixe claro ao usuário qual SKU usou.
- **Título:** padrão Mercado Livre, profissional, até 60 caracteres. Kit/caixa fechada: começa pela quantidade total de itens.
- **Custo:** da fonte que o usuário indicar (planilha NOVA ERA, Eletroleste, Mimosa...). Se vier uma página/print com preço (ex.: site da Eletroleste), é o custo; o código do fornecedor vai junto (ex.: "Eletroleste 384250").
- **Descrição:** texto puro, completa (limite 1000 caracteres do campo), com ESPECIFICAÇÕES TÉCNICAS só com dados confirmados. Sem emojis, sem promessa de norma/certificação.
- **Marca:** a real do produto.

## PESO e MEDIDAS: nunca chutar
(Erro grave já ocorrido: refil de 200 g cadastrado com 60 g.)
- Peso do produto **embalado**, em gramas (kg × 1000), arredondado para cima, de fonte real, nesta ordem: (1) anúncio do ML (`dados_para_upseller` do conector, se já existe); (2) planilha Acqualimp, aba "Tabela de Pesos e Medidas", para caixas d'água, tanques e filtros/refis Acqualimp; (3) ficha do fabricante; (4) pesquisa pelo **modelo exato** (código/referência) em lojas e marketplaces — compare 2 ou mais fontes; (5) só se não achar o exato: produto parecido da mesma linha.
- Confira se faz sentido (compare com produtos parecidos e com o tamanho da embalagem). Peso muito abaixo do esperado = pesquise de novo.
- Medidas em cm, arredondadas para cima. Confira a unidade marcada no campo (g, cm).

## NCM/CEST
Costumam não vir do fornecedor. Use o que a página do fornecedor mostrar (Class. Fiscal = NCM). Senão pesquise (Gemini/ChatGPT/busca) e use o NCM e o CEST do tipo de produto.

## Depois de preencher
1. Salve o produto.
2. Resposta curta ao usuário: SKU, título, custo, peso e medidas com a fonte de cada um, e o que veio de produto parecido ou pesquisa.
