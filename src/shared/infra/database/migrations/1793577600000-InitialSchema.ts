import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793577600000 implements MigrationInterface {
  name = 'InitialSchema1793577600000';

  public async up(q: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- wallets
    await q.query(`
      CREATE TABLE wallets (
        id          uuid          PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(19,2) NOT NULL DEFAULT 0,
        version     integer       NOT NULL DEFAULT 1,
        created_at  timestamptz   NOT NULL DEFAULT now(),
        updated_at  timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive     CHECK (version >= 1),
        CONSTRAINT wallets_currency_format      CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
      )
    `);

    // ------------------------------------------------------ wager_transactions
    await q.query(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL,
        external_transaction_id           text          NOT NULL,
        idempotency_key                   text          NOT NULL,
        payload_hash                      text          NOT NULL,
        wallet_id                         uuid          NOT NULL REFERENCES wallets(id),
        player_id                         uuid          NOT NULL,
        round_id                          text          NOT NULL,
        game_id                           text          NOT NULL,
        kind                              text          NOT NULL,
        amount                            numeric(19,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid          REFERENCES wager_transactions(id),
        status                            text          NOT NULL,
        failure_code                      text,
        observed_balance                  numeric(19,2),
        reference_attempts                integer       NOT NULL DEFAULT 0,
        next_reference_attempt_at         timestamptz,
        created_at                        timestamptz   NOT NULL DEFAULT now(),
        processed_at                      timestamptz,
        CONSTRAINT wager_tx_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_tx_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_observed_balance_non_negative CHECK (observed_balance IS NULL OR observed_balance >= 0),
        CONSTRAINT wager_tx_reference_required CHECK (
          (kind IN ('REFUND','ROLLBACK')) = (reference_external_transaction_id IS NOT NULL)
        ),
        CONSTRAINT wager_tx_failure_code_required CHECK (
          (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        )
      )
    `);

    // Uma referência só pode ser revertida uma vez pelo mesmo tipo de operação.
    await q.query(`
      CREATE UNIQUE INDEX wager_tx_one_reversal_per_reference
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')
    `);
    await q.query(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
    await q.query(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at)`);

    // Estados terminais não mudam mais (PROCESSED, REJECTED, FAILED).
    await q.query(`
      CREATE FUNCTION wager_transactions_guard_terminal() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transactions % is terminal (%) and cannot be updated', OLD.id, OLD.status;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await q.query(`
      CREATE TRIGGER wager_transactions_guard_terminal_trg
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard_terminal()
    `);

    // ---------------------------------------------------- wallet_ledger_entries
    await q.query(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid          PRIMARY KEY,
        wallet_id      uuid          NOT NULL REFERENCES wallets(id),
        transaction_id uuid          NOT NULL REFERENCES wager_transactions(id),
        direction      text          NOT NULL,
        amount         numeric(19,2) NOT NULL,
        currency       char(3)       NOT NULL,
        balance_before numeric(19,2) NOT NULL,
        balance_after  numeric(19,2) NOT NULL,
        created_at     timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT ledger_wallet_transaction_unique UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      )
    `);
    await q.query(`
      CREATE INDEX ledger_wallet_cursor_idx
        ON wallet_ledger_entries (wallet_id, created_at, id)
    `);

    // Ledger append-only: sem UPDATE nem DELETE.
    await q.query(`
      CREATE FUNCTION wallet_ledger_entries_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% not allowed)', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    await q.query(`
      CREATE TRIGGER wallet_ledger_entries_append_only_trg
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_append_only()
    `);

    // ---------------------------------------------------------- inbox / outbox
    await q.query(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  text        NOT NULL,
        received_at   timestamptz NOT NULL DEFAULT now(),
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);

    await q.query(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    uuid        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        published_at    timestamptz,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      )
    `);
    await q.query(`
      CREATE INDEX outbox_due_idx
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS outbox_messages`);
    await q.query(`DROP TABLE IF EXISTS inbox_messages`);
    await q.query(`DROP TRIGGER IF EXISTS wallet_ledger_entries_append_only_trg ON wallet_ledger_entries`);
    await q.query(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    await q.query(`DROP FUNCTION IF EXISTS wallet_ledger_entries_append_only()`);
    await q.query(`DROP TRIGGER IF EXISTS wager_transactions_guard_terminal_trg ON wager_transactions`);
    await q.query(`DROP TABLE IF EXISTS wager_transactions`);
    await q.query(`DROP FUNCTION IF EXISTS wager_transactions_guard_terminal()`);
    await q.query(`DROP TABLE IF EXISTS wallets`);
  }
}
