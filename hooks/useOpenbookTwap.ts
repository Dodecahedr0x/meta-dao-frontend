import { useCallback, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  AccountMeta,
  PublicKey,
  Transaction,
  VersionedTransaction,
  MessageV0,
} from '@solana/web3.js';
import { BN, Program } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PlaceOrderArgs } from '@openbook-dex/openbook-v2/dist/types/client';
import { SelfTradeBehavior, OrderType, Side } from '@openbook-dex/openbook-v2/dist/cjs/utils/utils';
import { OpenbookTwap } from '@/lib/idl/openbook_twap';
import { OPENBOOK_TWAP_PROGRAM_ID, QUOTE_LOTS } from '@/lib/constants';
import { FillEvent, MarketAccountWithKey, OutEvent, ProposalAccountWithKey } from '@/lib/types';
import { shortKey } from '@/lib/utils';
import { useProvider } from '@/hooks/useProvider';
import {
  createOpenOrdersIndexerInstruction,
  createOpenOrdersInstruction,
  findOpenOrders,
  findOpenOrdersIndexer,
} from '../lib/openbook';
import { useConditionalVault } from './useConditionalVault';
import { useOpenbook } from './useOpenbook';
import { useTransactionSender } from './useTransactionSender';

const OPENBOOK_TWAP_IDL: OpenbookTwap = require('@/lib/idl/openbook_twap.json');

const SYSTEM_PROGRAM: PublicKey = new PublicKey('11111111111111111111111111111111');

export function useOpenbookTwap() {
  const wallet = useWallet();
  const provider = useProvider();
  const sender = useTransactionSender();
  const { getVaultMint } = useConditionalVault();
  const openbook = useOpenbook();
  const openbookTwap = useMemo(() => {
    if (!provider) {
      return;
    }
    return new Program<OpenbookTwap>(OPENBOOK_TWAP_IDL, OPENBOOK_TWAP_PROGRAM_ID, provider);
  }, [provider]);

  const placeOrderTransactions = useCallback(
    async (
      amount: number,
      price: number,
      market: MarketAccountWithKey,
      limitOrder?: boolean,
      ask?: boolean,
      pass?: boolean,
      indexOffset?: number,
    ) => {
      if (!wallet.publicKey || !openbook || !openbookTwap) {
        return;
      }

      const mint = ask ? market.account.baseMint : market.account.quoteMint;
      const openTx = new Transaction();
      const openOrdersIndexer = findOpenOrdersIndexer(wallet.publicKey);
      let accountIndex = new BN(1);
      try {
        const indexer = await openbook.program.account.openOrdersIndexer.fetch(openOrdersIndexer);
        accountIndex = new BN((indexer?.createdCounter || 0) + 1 + (indexOffset || 0));
      } catch {
        if (!indexOffset) {
          openTx.add(
            await createOpenOrdersIndexerInstruction(
              openbook.program,
              openOrdersIndexer,
              wallet.publicKey,
            ),
          );
        } else {
          accountIndex = new BN(1 + (indexOffset || 0));
        }
      }
      const [ixs, openOrdersAccount] = await createOpenOrdersInstruction(
        openbook.program,
        market.publicKey,
        accountIndex,
        `${shortKey(wallet.publicKey)}-${accountIndex.toString()}`,
        wallet.publicKey,
        openOrdersIndexer,
      );
      openTx.add(...ixs);

      // const baseLot = 1;
      let priceLots = new BN(Math.floor(price / QUOTE_LOTS));
      const maxBaseLots = new BN(Math.floor(amount));
      let maxQuoteLotsIncludingFees = priceLots.mul(maxBaseLots);
      if (!limitOrder) {
        if (ask) {
          priceLots = new BN(1);
          maxQuoteLotsIncludingFees = new BN(Math.floor(10 / QUOTE_LOTS));
        } else {
          priceLots = new BN(1_000_000_000_000_000);
          maxQuoteLotsIncludingFees = priceLots.mul(maxBaseLots);
        }
      }
      const args: PlaceOrderArgs = {
        side: ask ? Side.Ask : Side.Bid,
        priceLots,
        maxBaseLots,
        maxQuoteLotsIncludingFees,
        clientOrderId: accountIndex,
        orderType: limitOrder ? OrderType.Limit : OrderType.Market,
        expiryTimestamp: new BN(0),
        selfTradeBehavior: SelfTradeBehavior.AbortTransaction,
        limit: 255,
      };
      const placeTx = await openbookTwap.methods
        .placeOrder(args)
        .accounts({
          openOrdersAccount,
          asks: market.account.asks,
          bids: market.account.bids,
          eventHeap: market.account.eventHeap,
          market: market.publicKey,
          marketVault: ask ? market.account.marketBaseVault : market.account.marketQuoteVault,
          twapMarket: PublicKey.findProgramAddressSync(
            [Buffer.from('twap_market'), market.publicKey.toBuffer()],
            OPENBOOK_TWAP_PROGRAM_ID,
          )[0],
          userTokenAccount: getAssociatedTokenAddressSync(mint, wallet.publicKey),
          openbookProgram: openbook.programId,
        })
        .preInstructions(openTx.instructions)
        .transaction();

      return [placeTx];
    },
    [wallet, openbookTwap],
  );

  const crankMarketTransactions = useCallback(
    async (market: MarketAccountWithKey, eventHeap: PublicKey, individualEvent?: PublicKey) => {
      if (!wallet.publicKey || !openbook || !openbookTwap) {
        return;
      }
      let accounts: PublicKey[] = new Array<PublicKey>();
      const _eventHeap = await openbook.program.account.eventHeap.fetch(eventHeap);
      // TODO: If null we should bail...
      if (!individualEvent) {
        if (_eventHeap != null) {
          // eslint-disable-next-line no-restricted-syntax
          for (const node of _eventHeap.nodes) {
            if (node.event.eventType === 0) {
              const fillEvent: FillEvent = openbook.program.coder.types.decode(
                'FillEvent',
                Buffer.from([0, ...node.event.padding]),
              );
              accounts = accounts.filter((a) => a !== fillEvent.maker).concat([fillEvent.maker]);
            } else {
              const outEvent: OutEvent = openbook.program.coder.types.decode(
                'OutEvent',
                Buffer.from([0, ...node.event.padding]),
              );
              accounts = accounts.filter((a) => a !== outEvent.owner).concat([outEvent.owner]);
            }
            // Tx would be too big, do not add more accounts
            if (accounts.length > 20) {
              break;
            }
          }
        }
      } else if (_eventHeap != null) {
        // eslint-disable-next-line no-restricted-syntax
        for (const node of _eventHeap.nodes) {
          if (node.event.eventType === 0) {
            const fillEvent: FillEvent = openbook.program.coder.types.decode(
              'FillEvent',
              Buffer.from([0, ...node.event.padding]),
            );
            accounts = accounts.filter((a) => a !== fillEvent.maker).concat([fillEvent.maker]);
          } else {
            const outEvent: OutEvent = openbook.program.coder.types.decode(
              'OutEvent',
              Buffer.from([0, ...node.event.padding]),
            );
            accounts = accounts.filter((a) => a !== outEvent.owner).concat([outEvent.owner]);
          }
        }
      }

      const accountsMeta: AccountMeta[] = accounts.map((remaining) => ({
        pubkey: remaining,
        isSigner: false,
        isWritable: true,
      }));
      let filteredAccounts = accountsMeta;
      if (individualEvent) {
        filteredAccounts = accountsMeta.filter(
          (order) => order.pubkey.toString() === individualEvent.toString(),
        );
      }
      const crankIx = await openbook.program.methods
        .consumeEvents(new BN(filteredAccounts.length))
        .accounts({
          consumeEventsAdmin: openbook.programId,
          market: market.publicKey,
          eventHeap: market.account.eventHeap,
        })
        .remainingAccounts(filteredAccounts)
        .instruction();

      const latestBlockhash = await provider.connection.getLatestBlockhash();

      const message = MessageV0.compile({
        payerKey: provider.wallet.publicKey,
        instructions: [crankIx],
        recentBlockhash: latestBlockhash.blockhash,
        addressLookupTableAccounts: undefined,
      });

      const vtx = new VersionedTransaction(message);

      return [vtx];
    },
    [wallet, openbook, provider],
  );

  const crankMarket = useCallback(
    async (market: MarketAccountWithKey, eventHeap: PublicKey, individualEvent?: PublicKey) => {
      const txs = await crankMarketTransactions(market, eventHeap, individualEvent);
      if (!txs) {
        return;
      }

      return sender.send(txs);
    },
    [crankMarketTransactions, sender],
  );

  const settleFundsTransactions = useCallback(
    async (
      orderId: BN,
      passMarket: boolean,
      proposal: ProposalAccountWithKey,
      market: MarketAccountWithKey,
    ) => {
      if (!wallet.publicKey || !openbook) {
        return;
      }
      const quoteVault = await getVaultMint(proposal.account.quoteVault);
      const baseVault = await getVaultMint(proposal.account.baseVault);
      const openOrdersAccount = findOpenOrders(orderId, wallet.publicKey);
      // TODO: Determine if order is on pass or fail market?
      const userBasePass = getAssociatedTokenAddressSync(
        baseVault.conditionalOnFinalizeTokenMint,
        wallet.publicKey,
      );
      const userQuotePass = getAssociatedTokenAddressSync(
        quoteVault.conditionalOnFinalizeTokenMint,
        wallet.publicKey,
      );
      const userBaseFail = getAssociatedTokenAddressSync(
        baseVault.conditionalOnRevertTokenMint,
        wallet.publicKey,
      );
      const userQuoteFail = getAssociatedTokenAddressSync(
        quoteVault.conditionalOnRevertTokenMint,
        wallet.publicKey,
      );
      let userBaseAccount = userBaseFail;
      let userQuoteAccount = userQuoteFail;
      if (passMarket) {
        userBaseAccount = userBasePass;
        userQuoteAccount = userQuotePass;
      }
      // TODO: 2x Txns for each side..
      const placeTx = await openbook.program.methods
        .settleFunds()
        .accounts({
          owner: wallet.publicKey,
          penaltyPayer: wallet.publicKey,
          openOrdersAccount,
          market: market.publicKey,
          marketAuthority: market.account.marketAuthority,
          marketBaseVault: market.account.marketBaseVault,
          marketQuoteVault: market.account.marketQuoteVault,
          userBaseAccount,
          userQuoteAccount,
          referrerAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM,
        })
        .transaction();
      return [placeTx];
    },
    [wallet, openbook],
  );

  const closeOpenOrdersAccountTransactions = useCallback(
    async (orderId: BN) => {
      if (!wallet.publicKey || !openbook) {
        return;
      }

      const openOrdersIndexer = findOpenOrdersIndexer(wallet.publicKey);
      const openOrdersAccount = findOpenOrders(orderId, wallet.publicKey);
      const closeTx = await openbook.program.methods
        .closeOpenOrdersAccount()
        .accounts({
          owner: wallet.publicKey,
          openOrdersIndexer,
          openOrdersAccount,
          solDestination: wallet.publicKey,
        })
        .transaction();

      return [closeTx];
    },
    [wallet, openbook],
  );

  const cancelOrderTransactions = useCallback(
    async (orderId: BN, market: MarketAccountWithKey) => {
      if (!wallet.publicKey || !openbook || !openbookTwap) {
        return;
      }

      const openOrdersAccount = findOpenOrders(orderId, wallet.publicKey);
      const placeTx = await openbookTwap.methods
        .cancelOrderByClientId(orderId)
        .accounts({
          openOrdersAccount,
          asks: market.account.asks,
          bids: market.account.bids,
          market: market.publicKey,
          twapMarket: PublicKey.findProgramAddressSync(
            [Buffer.from('twap_market'), market.publicKey.toBuffer()],
            OPENBOOK_TWAP_PROGRAM_ID,
          )[0],
          openbookProgram: openbook.programId,
        })
        .transaction();

      return [placeTx];
    },
    [wallet, openbook, openbookTwap],
  );

  return {
    placeOrderTransactions,
    cancelOrderTransactions,
    closeOpenOrdersAccountTransactions,
    settleFundsTransactions,
    crankMarket,
    crankMarketTransactions,
    program: openbookTwap,
  };
}
