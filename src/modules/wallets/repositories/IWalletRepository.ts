import type { Wallet } from '../domain/Wallet';

export const WALLET_REPOSITORY = Symbol('IWalletRepository');

export interface IWalletRepository {
  /** INSERT ... ON CONFLICT (player_id, currency) DO NOTHING. false = já existia (conflito). */
  insert(wallet: Wallet): Promise<boolean>;

  findById(id: string): Promise<Wallet | null>;

  /**
   * SELECT ... FOR UPDATE: trava só a linha desta wallet até o fim da transação
   * (a unidade de concorrência é a walletId; não há lock global). Exige transação ativa.
   */
  findByIdForUpdate(id: string): Promise<Wallet | null>;

  /**
   * UPDATE ... WHERE id = $1 AND version = $previousVersion.
   * Lança erro de concorrência se nenhuma linha for afetada (rede de segurança
   * além do lock: o saldo nunca é gravado sobre uma leitura velha).
   */
  save(wallet: Wallet, previousVersion: number): Promise<void>;
}
