# Arquitetura e Decisões de Projeto

## 1. Domínio e Regras de Negócio (`Money` e Entidades)

- **Decimal exato:** O `Money` utiliza `decimal.js`, nunca `number`, e o valor é serializado sempre como `string` com 2 casas decimais[cite: 6].
- **Entrada estrita:** `Money.from` rejeita valores vazios, `NaN`, `Infinity`, notação científica, sinal, vírgula, mais de 2 casas e argumentos que não sejam `string`. A moeda precisa ser um código de 3 letras maiúsculas[cite: 6].
- **Negativos restritos ao domínio interno:** O método `from` rejeita negativos por ser a porta de entrada dos contratos; porém, `subtract` e `negate` podem gerar valores negativos necessários para `ROLLBACK` e checagem de saldo[cite: 6].
- **Normalização:** `"25"` vira `"25.00"` (aceita de 0 a 2 casas na entrada e normaliza). O zero é normalizado no construtor para evitar `"-0.00"`[cite: 6].
- **Wallet e Ledger:**
  - `Wallet` devolve o lançamento: `debit()` e `credit()` alteram o saldo e retornam o `WalletLedgerEntry` correspondente, impedindo divergências entre saldo e ledger[cite: 6].
  - A versão (`version`) começa em 1 e só incrementa quando o saldo muda[cite: 6].
  - **Ledger imutável:** Campos marcados como `readonly` e instâncias congeladas com `Object.freeze`. Valida valor positivo, moedas iguais e consistência aritmética[cite: 6].
  - IDs e datas entram por parâmetro (`entryId`, `at`), tornando o domínio determinístico e fácil de testar[cite: 6].

## 2. Transações (`WagerTransaction`)

- **Transições:** Estados terminais lançam `InvalidTransactionStateError` em tentativas de nova transição[cite: 6].
- **`observedBalance`:** Gravado junto ao estado final, permitindo responder a um _replay_ com o saldo original (inclusive para `LOSS` e transações rejeitadas, que não geram lançamentos no ledger)[cite: 6].
- **Controle de Referências:** `reference_attempts` e `next_reference_attempt_at` dão suporte ao worker de `PENDING_REFERENCE` com _backoff_[cite: 6].
- **Abertura (`OPENING`):** Exige `idempotency_key` e `external_transaction_id` gerados internamente (`provider_id = 'internal'` e `opening:<walletId>`)[cite: 6].
- **Validação Cruzada:** Regras que cruzam linhas (mesmo provedor, player, wallet, moeda e rodada entre a transação e a referência) ficam no _use case_, pois o banco não as expressa com facilidade[cite: 6].
- **Valor Zero:** Apenas `LOSS` aceita `0.00`. As demais operações exigem valor maior que zero validado na criação (virando erro de payload `400`, e não rejeição de negócio)[cite: 6].
- **`FailureCode`:** São 11 códigos, cada um com a ação sugerida para o provedor (`FIX_PAYLOAD` ou `GIVE_UP`), respondendo ao item 7.2 do README. Falhas transitórias recebem HTTP `503` para reenvio[cite: 6].

## 3. Infraestrutura e Persistência

- **Isolamento e Locks:** Isolamento `READ COMMITTED` + lock de linha por wallet (_pessimistic locking_), evitando os _retries_ em cascata do _optimistic locking_ sob alta disputa em _hot wallets_. O lock é estritamente da linha, sem bloqueio global[cite: 6].
- **Versão como Rede de Segurança:** O método `save` realiza `UPDATE ... WHERE version = $anterior` para garantir que o saldo não seja gravado sobre leituras defasadas[cite: 6].
- **Idempotência Persistente:** `insertIfAbsent` com `ON CONFLICT DO NOTHING`, delegando ao banco a decisão de qual requisição simultânea é a primeira, sem cache em memória[cite: 6].
- **Processamento de Pendências:** `findDuePendingReference` utilizando `SKIP LOCKED` para permitir lotes concorrentes em múltiplos workers[cite: 6].
- **SQL Explícito:** Uso explícito de SQL para `FOR UPDATE`, `ON CONFLICT` e `SKIP LOCKED` para assegurar correção, mantendo o TypeORM responsável por conexões, transações e migrations[cite: 6].
- **Precisão de Tipos e Datas:** O `numeric(19,2)` chega do driver como string e é convertido para `Money`. O cursor utiliza `created_at` em texto com microssegundos para evitar truncamento de milissegundos do `Date` do JavaScript[cite: 6].
- **Testes:** O `TRUNCATE` limpa as tabelas entre os cenários (os triggers do ledger bloqueiam apenas `UPDATE` e `DELETE`)[cite: 6].

## 4. Cobertura de Testes

- **Cenário Obrigatório:** 100,00 e duas apostas de 80,00 (uma `PROCESSED`, outra `REJECTED`, saldo final de 20,00 e um único débito). _Retries_ viram _replays_ sem duplicação[cite: 6].
- **Concorrência:** Mesma aposta disparada 50x em paralelo gerando um único débito[cite: 6].
- **Hot Wallet:** 100 apostas de 10,00 sobre 500,00 aprovam exatamente 50 transações, avaliando também 20 wallets em paralelo[cite: 6].
- **Referências Fora de Ordem:** Tratamento de `REFUND` antes da `BET` (fica pendente até conclusão pelo worker), limite esgotado e concorrência de dois workers[cite: 6].
- **Atomicidade:** Falhas na _outbox_ impedem gravações parciais, permitindo reenvio via _retry_[cite: 6].
- **Invariante Final:** Validação de que `wallet.balance` corresponde ao saldo reconstruído pelo ledger em quase todos os cenários[cite: 6].

## 5. Interpretações para Documentar

- **Reversões:** Uma referência aceita uma reversão processada de qualquer tipo (evitando duplo crédito em `REFUND` seguido de `ROLLBACK` da mesma `BET`). O `ROLLBACK` de um `REFUND` continua permitido[cite: 6].
- **Wallet de Outro Player ou Moeda:** Transações são rejeitadas e persistidas com códigos específicos (`WALLET_PLAYER_MISMATCH` ou `CURRENCY_MISMATCH`), mas o saldo não é retornado na resposta para evitar vazamento de dados de terceiros[cite: 6].
- **Wallet Inexistente:** Trata-se de erro 404 sem persistência, pois a chave estrangeira exige a carteira pré-existente[cite: 6].
- **`payloadHash`:** SHA-256 do JSON canônico (chaves ordenadas) dos campos de negócio com dinheiro normalizado (ex: "25" e "25.00" geram o mesmo hash). A chave de idempotência é desconsiderada no hash[cite: 6].
- **`PendingReference`:** O evento é publicado apenas na primeira vez; tentativas subsequentes não geram novas publicações[cite: 6].
- **Eventos:** O `aggregateId` é sempre o `walletId` para manter a ordem FIFO por carteira no SQS. Consumidores utilizam o `walletVersion` de `WalletBalanceChanged` para ordenação[cite: 6].
