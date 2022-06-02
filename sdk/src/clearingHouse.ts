import { AnchorProvider, BN, Idl, Program } from '@project-serum/anchor';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	StateAccount,
	DepositHistoryAccount,
	FundingPaymentHistoryAccount,
	FundingRateHistoryAccount,
	IWallet,
	LiquidationHistoryAccount,
	PositionDirection,
	TradeHistoryAccount,
	UserAccount,
	MarketAccount,
	OrderHistoryAccount,
	OrderStateAccount,
	OrderParams,
	Order,
	ExtendedCurveHistoryAccount,
	UserPositionsAccount,
	UserOrdersAccount,
} from './types';
import * as anchor from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';

import {
	Connection,
	PublicKey,
	TransactionSignature,
	ConfirmOptions,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';

import { MockUSDCFaucet } from './mockUSDCFaucet';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';
import {
	getClearingHouseStateAccountPublicKey,
	getMarketPublicKey,
	getOrderStateAccountPublicKey,
	getUserAccountPublicKey,
	getUserAccountPublicKeyAndNonce,
	getUserOrdersAccountPublicKey,
	getUserOrdersAccountPublicKeyAndNonce,
	getUserPositionsAccountPublicKey,
} from './addresses/pda';
import {
	ClearingHouseAccountSubscriber,
	ClearingHouseAccountEvents,
	ClearingHouseAccountTypes,
} from './accounts/types';
import { TxSender } from './tx/types';
import { wrapInTx } from './tx/utils';
import {
	getClearingHouse,
	getWebSocketClearingHouseConfig,
} from './factory/clearingHouse';
import { ZERO } from './constants/numericConstants';
import { positionIsAvailable } from './math/position';
import { getMarketAddress } from './addresses/marketAddresses';

/**
 * # ClearingHouse
 * This class is the main way to interact with Drift Protocol. It allows you to subscribe to the various accounts where the Market's state is stored, as well as: opening positions, liquidating, settling funding, depositing & withdrawing, and more.
 *
 * The default way to construct a ClearingHouse instance is using the {@link from} method. This will create an instance using the static {@link WebSocketClearingHouseAccountSubscriber}, which will use a websocket for each state account subscription.
 * Alternatively, if you want to implement your own method of subscribing to the state accounts on the blockchain, you can implement a {@link ClearingHouseAccountSubscriber} and use it in the {@link ClearingHouse.constructor}
 */
export class ClearingHouse {
	connection: Connection;
	wallet: IWallet;
	public program: Program;
	provider: AnchorProvider;
	opts?: ConfirmOptions;
	accountSubscriber: ClearingHouseAccountSubscriber;
	eventEmitter: StrictEventEmitter<EventEmitter, ClearingHouseAccountEvents>;
	_isSubscribed = false;
	txSender: TxSender;

	public get isSubscribed() {
		return this._isSubscribed && this.accountSubscriber.isSubscribed;
	}

	public set isSubscribed(val: boolean) {
		this._isSubscribed = val;
	}

	/**
	 * @deprecated You should use the getClearingHouse factory method instead
	 * @param connection
	 * @param wallet
	 * @param clearingHouseProgramId
	 * @param opts
	 * @returns
	 */
	public static from(
		connection: Connection,
		wallet: IWallet,
		clearingHouseProgramId: PublicKey,
		opts: ConfirmOptions = AnchorProvider.defaultOptions()
	): ClearingHouse {
		const config = getWebSocketClearingHouseConfig(
			connection,
			wallet,
			clearingHouseProgramId,
			opts
		);
		return getClearingHouse(config);
	}

	public constructor(
		connection: Connection,
		wallet: IWallet,
		program: Program,
		accountSubscriber: ClearingHouseAccountSubscriber,
		txSender: TxSender,
		opts: ConfirmOptions
	) {
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
		this.program = program;
		this.accountSubscriber = accountSubscriber;
		this.eventEmitter = this.accountSubscriber.eventEmitter;
		this.txSender = txSender;
	}

	/**
	 *
	 * @param optionalSubscriptions - Optional extra accounts to subcribe to. Always subscribes to base clearing house state and market account state by default. You should only subscribe to optional extra accounts if required, to avoid overloading your RPC.
	 * @returns Promise<boolean> : SubscriptionSuccess
	 */
	public async subscribe(
		optionalSubscriptions?: ClearingHouseAccountTypes[]
	): Promise<boolean> {
		this.isSubscribed = await this.accountSubscriber.subscribe(
			optionalSubscriptions
		);
		return this.isSubscribed;
	}

	/**
	 * Shorthand function to subscribe to all available Clearing House State Accounts
	 * @returns Promise<boolean> : SubscriptionSuccess
	 */
	public async subscribeToAll(): Promise<boolean> {
		return this.subscribe([
			'curveHistoryAccount',
			'depositHistoryAccount',
			'fundingPaymentHistoryAccount',
			'fundingRateHistoryAccount',
			'liquidationHistoryAccount',
			'tradeHistoryAccount',
			'orderHistoryAccount',
		]);
	}

	/**
	 *	Forces the accountSubscriber to fetch account updates from rpc
	 */
	public async fetchAccounts(): Promise<void> {
		await this.accountSubscriber.fetch();
	}

	/**
	 * Unsubscribe from all currently subscribed state accounts
	 */
	public async unsubscribe(): Promise<void> {
		await this.accountSubscriber.unsubscribe();
		this.isSubscribed = false;
	}

	statePublicKey?: PublicKey;
	public async getStatePublicKey(): Promise<PublicKey> {
		if (this.statePublicKey) {
			return this.statePublicKey;
		}
		this.statePublicKey = await getClearingHouseStateAccountPublicKey(
			this.program.programId
		);
		return this.statePublicKey;
	}

	public getStateAccount(): StateAccount {
		return this.accountSubscriber.getStateAccount();
	}

	public getMarketAccount(marketIndex: BN | number): MarketAccount {
		marketIndex = marketIndex instanceof BN ? marketIndex : new BN(marketIndex);
		return this.accountSubscriber.getMarketAccount(marketIndex);
	}

	public getFundingPaymentHistoryAccount(): FundingPaymentHistoryAccount {
		return this.accountSubscriber.getFundingPaymentHistoryAccount();
	}

	public getFundingRateHistoryAccount(): FundingRateHistoryAccount {
		return this.accountSubscriber.getFundingRateHistoryAccount();
	}

	public getTradeHistoryAccount(): TradeHistoryAccount {
		return this.accountSubscriber.getTradeHistoryAccount();
	}

	public getLiquidationHistoryAccount(): LiquidationHistoryAccount {
		return this.accountSubscriber.getLiquidationHistoryAccount();
	}

	public getDepositHistoryAccount(): DepositHistoryAccount {
		return this.accountSubscriber.getDepositHistoryAccount();
	}

	public getCurveHistoryAccount(): ExtendedCurveHistoryAccount {
		return this.accountSubscriber.getCurveHistoryAccount();
	}

	public getOrderHistoryAccount(): OrderHistoryAccount {
		return this.accountSubscriber.getOrderHistoryAccount();
	}

	orderStatePublicKey?: PublicKey;
	public async getOrderStatePublicKey(): Promise<PublicKey> {
		if (this.orderStatePublicKey) {
			return this.orderStatePublicKey;
		}
		this.orderStatePublicKey = await getOrderStateAccountPublicKey(
			this.program.programId
		);
		return this.orderStatePublicKey;
	}

	public getOrderStateAccount(): OrderStateAccount {
		return this.accountSubscriber.getOrderStateAccount();
	}

	/**
	 * Update the wallet to use for clearing house transactions and linked user account
	 * @param newWallet
	 */
	public async updateWallet(newWallet: IWallet): Promise<void> {
		const newProvider = new AnchorProvider(
			this.connection,
			newWallet,
			this.opts
		);
		const newProgram = new Program(
			clearingHouseIDL as Idl,
			this.program.programId,
			newProvider
		);

		// Update provider for txSender with new wallet details
		this.txSender.provider = newProvider;

		this.wallet = newWallet;
		this.provider = newProvider;
		this.program = newProgram;
		this.userAccountPublicKey = undefined;
		this.userPositionsAccountPublicKey = undefined;
		this.userOrdersAccountPublicKey = undefined;
		await this.accountSubscriber.updateAuthority(newWallet.publicKey);
	}

	public async initializeUserAccount(): Promise<
		[TransactionSignature, PublicKey]
	> {
		const [
			userAccountPublicKey,
			initializeUserAccountIx,
			initializeUserOrdersAccountIx,
		] = await this.getInitializeUserInstructions();

		const tx = new Transaction()
			.add(initializeUserAccountIx)
			.add(initializeUserOrdersAccountIx);
		const txSig = await this.txSender.send(tx, [], this.opts);
		return [txSig, userAccountPublicKey];
	}

	async getInitializeUserInstructions(): Promise<
		[PublicKey, TransactionInstruction, TransactionInstruction]
	> {
		const [userAccountPublicKey, userAccountNonce] =
			await getUserAccountPublicKeyAndNonce(
				this.program.programId,
				this.wallet.publicKey
			);

		const userPositionsPublicKey = await getUserPositionsAccountPublicKey(
			this.program.programId,
			userAccountPublicKey
		);

		const remainingAccounts = [];
		const optionalAccounts = {
			whitelistToken: false,
		};

		const state = this.getStateAccount();
		if (state.whitelistMint) {
			optionalAccounts.whitelistToken = true;
			const associatedTokenPublicKey = await Token.getAssociatedTokenAddress(
				ASSOCIATED_TOKEN_PROGRAM_ID,
				TOKEN_PROGRAM_ID,
				state.whitelistMint,
				this.wallet.publicKey
			);
			remainingAccounts.push({
				pubkey: associatedTokenPublicKey,
				isWritable: false,
				isSigner: false,
			});
		}

		const initializeUserAccountIx =
			await this.program.instruction.initializeUser(
				userAccountNonce,
				optionalAccounts,
				{
					accounts: {
						user: userAccountPublicKey,
						authority: this.wallet.publicKey,
						rent: anchor.web3.SYSVAR_RENT_PUBKEY,
						systemProgram: anchor.web3.SystemProgram.programId,
						userPositions: userPositionsPublicKey,
						state: await this.getStatePublicKey(),
					},
					remainingAccounts: remainingAccounts,
				}
			);

		const initializeUserOrdersAccountIx =
			await this.getInitializeUserOrdersInstruction(userAccountPublicKey);

		return [
			userAccountPublicKey,
			initializeUserAccountIx,
			initializeUserOrdersAccountIx,
		];
	}

	async getInitializeUserOrdersInstruction(
		userAccountPublicKey?: PublicKey
	): Promise<TransactionInstruction> {
		if (!userAccountPublicKey) {
			userAccountPublicKey = await this.getUserAccountPublicKey();
		}

		const [userOrdersAccountPublicKey, userOrdersAccountNonce] =
			await getUserOrdersAccountPublicKeyAndNonce(
				this.program.programId,
				userAccountPublicKey
			);

		return await this.program.instruction.initializeUserOrders(
			userOrdersAccountNonce,
			{
				accounts: {
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					rent: anchor.web3.SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					userOrders: userOrdersAccountPublicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	userAccountPublicKey?: PublicKey;
	/**
	 * Get the address for the Clearing House User's account. NOT the user's wallet address.
	 * @returns
	 */
	public async getUserAccountPublicKey(): Promise<PublicKey> {
		if (this.userAccountPublicKey) {
			return this.userAccountPublicKey;
		}

		this.userAccountPublicKey = await getUserAccountPublicKey(
			this.program.programId,
			this.wallet.publicKey
		);
		return this.userAccountPublicKey;
	}

	public getUserAccount(): UserAccount | undefined {
		return this.accountSubscriber.getUserAccount();
	}

	userPositionsAccountPublicKey?: PublicKey;
	/**
	 * Get the address for the Clearing House User Positions's account. NOT the user's wallet address.
	 * @returns
	 */
	public async getUserPositionsAccountPublicKey(): Promise<PublicKey> {
		if (this.userPositionsAccountPublicKey) {
			return this.userPositionsAccountPublicKey;
		}

		this.userPositionsAccountPublicKey = await getUserPositionsAccountPublicKey(
			this.program.programId,
			await this.getUserAccountPublicKey()
		);
		return this.userPositionsAccountPublicKey;
	}

	public getUserPositionsAccount(): UserPositionsAccount | undefined {
		return this.accountSubscriber.getUserPositionsAccount();
	}

	getUserMarketIndexes(): BN[] {
		const userPositionsAccount = this.getUserPositionsAccount();
		if (!userPositionsAccount) {
			throw Error(
				'No user positions account found. Most likely user account does not exist or failed to fetch account'
			);
		}

		return userPositionsAccount.positions.reduce((markets, position) => {
			if (!positionIsAvailable(position)) {
				markets.push(position.marketIndex);
			}
			return markets;
		}, new Array<BN>());
	}

	async getUserMarketPublicKeys(skipMarketIndex?: BN): Promise<PublicKey[]> {
		const marketPublicKeys = [];
		for (const marketIndex of this.getUserMarketIndexes()) {
			if (skipMarketIndex && marketIndex.eq(skipMarketIndex)) {
				continue;
			}

			marketPublicKeys.push(
				await getMarketAddress(this.program.programId, marketIndex)
			);
		}
		return marketPublicKeys;
	}

	userOrdersAccountPublicKey?: PublicKey;
	/**
	 * Get the address for the Clearing House User Order's account. NOT the user's wallet address.
	 * @returns
	 */
	public async getUserOrdersAccountPublicKey(): Promise<PublicKey> {
		if (this.userOrdersAccountPublicKey) {
			return this.userOrdersAccountPublicKey;
		}

		this.userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
			this.program.programId,
			await this.getUserAccountPublicKey()
		);
		return this.userOrdersAccountPublicKey;
	}

	public getUserOrdersAccount(): UserOrdersAccount | undefined {
		return this.accountSubscriber.getUserOrdersAccount();
	}

	public getOrder(orderId: BN | number): Order | undefined {
		const orderIdBN = orderId instanceof BN ? orderId : new BN(orderId);
		return this.getUserOrdersAccount()?.orders.find((order) =>
			order.orderId.eq(orderIdBN)
		);
	}

	public getOrderByUserId(userOrderId: number): Order | undefined {
		return this.getUserOrdersAccount()?.orders.find(
			(order) => order.userOrderId === userOrderId
		);
	}

	userOrdersAccountExists(): boolean {
		return this.accountSubscriber.getUserOrdersAccount() !== undefined;
	}

	public async depositCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		const depositCollateralIx = await this.getDepositCollateralInstruction(
			amount,
			collateralAccountPublicKey
		);

		const tx = new Transaction().add(depositCollateralIx);

		return await this.txSender.send(tx);
	}

	async getDepositCollateralInstruction(
		amount: BN,
		collateralAccountPublicKey: PublicKey,
		userInitialized = true
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsAccountPublicKey =
			await this.getUserPositionsAccountPublicKey();

		const remainingAccounts = [];
		if (userInitialized) {
			(await this.getUserMarketPublicKeys()).forEach((marketPublicKey) => {
				remainingAccounts.push({
					pubkey: marketPublicKey,
					isWritable: false,
					isSigner: false,
				});
			});
		}

		const state = this.getStateAccount();
		return await this.program.instruction.depositCollateral(amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				collateralVault: state.collateralVault,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				fundingPaymentHistory: state.fundingPaymentHistory,
				depositHistory: state.depositHistory,
				userPositions: userPositionsAccountPublicKey,
			},
			remainingAccounts,
		});
	}

	/**
	 * Creates the Clearing House User account for a user, and deposits some initial collateral
	 * @param amount
	 * @param collateralAccountPublicKey
	 * @returns
	 */
	public async initializeUserAccountAndDepositCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<[TransactionSignature, PublicKey]> {
		const [
			userAccountPublicKey,
			initializeUserAccountIx,
			initializeUserOrdersAccountIx,
		] = await this.getInitializeUserInstructions();

		const depositCollateralIx = await this.getDepositCollateralInstruction(
			amount,
			collateralAccountPublicKey,
			false
		);

		const tx = new Transaction()
			.add(initializeUserAccountIx)
			.add(initializeUserOrdersAccountIx)
			.add(depositCollateralIx);

		const txSig = await this.txSender.send(tx, []);

		return [txSig, userAccountPublicKey];
	}

	public async initializeUserAccountForDevnet(
		mockUSDCFaucet: MockUSDCFaucet,
		amount: BN
	): Promise<[TransactionSignature, PublicKey]> {
		const [associateTokenPublicKey, createAssociatedAccountIx, mintToIx] =
			await mockUSDCFaucet.createAssociatedTokenAccountAndMintToInstructions(
				this.wallet.publicKey,
				amount
			);

		const [
			userAccountPublicKey,
			initializeUserAccountIx,
			initializeUserOrdersAccountIx,
		] = await this.getInitializeUserInstructions();

		const depositCollateralIx = await this.getDepositCollateralInstruction(
			amount,
			associateTokenPublicKey,
			false
		);

		const tx = new Transaction()
			.add(createAssociatedAccountIx)
			.add(mintToIx)
			.add(initializeUserAccountIx)
			.add(initializeUserOrdersAccountIx)
			.add(depositCollateralIx);

		const txSig = await this.program.provider.sendAndConfirm(tx, []);

		return [txSig, userAccountPublicKey];
	}

	public async withdrawCollateral(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(
				await this.getWithdrawCollateralIx(amount, collateralAccountPublicKey)
			),
			[],
			this.opts
		);
	}

	public async getWithdrawCollateralIx(
		amount: BN,
		collateralAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsPublicKey =
			await this.getUserPositionsAccountPublicKey();

		const state = this.getStateAccount();

		const remainingAccounts = [];
		(await this.getUserMarketPublicKeys()).forEach((marketPublicKey) => {
			remainingAccounts.push({
				pubkey: marketPublicKey,
				isWritable: false,
				isSigner: false,
			});
		});

		return await this.program.instruction.withdrawCollateral(amount, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				collateralVault: state.collateralVault,
				collateralVaultAuthority: state.collateralVaultAuthority,
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				userCollateralAccount: collateralAccountPublicKey,
				authority: this.wallet.publicKey,
				tokenProgram: TOKEN_PROGRAM_ID,
				userPositions: userPositionsPublicKey,
				fundingPaymentHistory: state.fundingPaymentHistory,
				depositHistory: state.depositHistory,
			},
			remainingAccounts,
		});
	}

	public async openPosition(
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		limitPrice?: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getOpenPositionIx(
					direction,
					amount,
					marketIndex,
					limitPrice,
					discountToken,
					referrer
				)
			),
			[],
			this.opts
		);
	}

	public async getOpenPositionIx(
		direction: PositionDirection,
		amount: BN,
		marketIndex: BN,
		limitPrice?: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsAccountPublicKey =
			await this.getUserPositionsAccountPublicKey();

		if (limitPrice == undefined) {
			limitPrice = new BN(0); // no limit
		}

		const remainingAccounts = [
			{
				pubkey: await getMarketAddress(this.program.programId, marketIndex),
				isSigner: false,
				isWritable: true,
			},
		];
		(await this.getUserMarketPublicKeys(marketIndex)).forEach(
			(marketPublicKey) => {
				remainingAccounts.push({
					pubkey: marketPublicKey,
					isWritable: false,
					isSigner: false,
				});
			}
		);

		const optionalAccounts = {
			discountToken: false,
			referrer: false,
		};
		if (discountToken) {
			optionalAccounts.discountToken = true;
			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}
		if (referrer) {
			optionalAccounts.referrer = true;
			remainingAccounts.push({
				pubkey: referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const priceOracle = this.getMarketAccount(marketIndex).amm.oracle;

		const state = this.getStateAccount();
		return await this.program.instruction.openPosition(
			direction,
			amount,
			marketIndex,
			limitPrice,
			optionalAccounts,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					userPositions: userPositionsAccountPublicKey,
					tradeHistory: state.tradeHistory,
					fundingPaymentHistory: state.fundingPaymentHistory,
					fundingRateHistory: state.fundingRateHistory,
					oracle: priceOracle,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async initializeUserOrdersThenPlaceOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		const instructions: anchor.web3.TransactionInstruction[] = [];
		const userOrdersAccountExists = this.userOrdersAccountExists();
		if (!userOrdersAccountExists) {
			instructions.push(await this.getInitializeUserOrdersInstruction());
		}
		instructions.push(
			await this.getPlaceOrderIx(orderParams, discountToken, referrer)
		);
		const tx = new Transaction();
		for (const instruction of instructions) {
			tx.add(instruction);
		}

		return await this.txSender.send(tx, [], this.opts);
	}

	public async placeOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getPlaceOrderIx(orderParams, discountToken, referrer)
			),
			[],
			this.opts
		);
	}

	public async getPlaceOrderIx(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsAccountPublicKey =
			await this.getUserPositionsAccountPublicKey();

		const priceOracle = this.getMarketAccount(orderParams.marketIndex).amm
			.oracle;

		const remainingAccounts = [
			{
				pubkey: await getMarketAddress(
					this.program.programId,
					orderParams.marketIndex
				),
				isSigner: false,
				isWritable: false,
			},
		];
		(await this.getUserMarketPublicKeys()).forEach((marketPublicKey) => {
			remainingAccounts.push({
				pubkey: marketPublicKey,
				isWritable: false,
				isSigner: false,
			});
		});

		if (orderParams.optionalAccounts.discountToken) {
			if (!discountToken) {
				throw Error(
					'Optional accounts specified discount token but no discount token present'
				);
			}

			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}

		if (orderParams.optionalAccounts.referrer) {
			if (!referrer) {
				throw Error(
					'Optional accounts specified referrer but no referrer present'
				);
			}

			remainingAccounts.push({
				pubkey: referrer,
				isWritable: false,
				isSigner: false,
			});
		}

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();
		return await this.program.instruction.placeOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				userOrders: await this.getUserOrdersAccountPublicKey(),
				userPositions: userPositionsAccountPublicKey,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
				oracle: priceOracle,
			},
			remainingAccounts,
		});
	}

	public async expireOrders(
		userAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getExpireOrdersIx(
					userAccountPublicKey,
					userOrdersAccountPublicKey
				)
			),
			[],
			this.opts
		);
	}

	public async getExpireOrdersIx(
		userAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();
		const userPositionsPublicKey = await getUserPositionsAccountPublicKey(
			this.program.programId,
			userAccountPublicKey
		);

		const orderState = this.getOrderStateAccount();
		return await this.program.instruction.expireOrders({
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				userPositions: userPositionsPublicKey,
				userOrders: userOrdersAccountPublicKey,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
			},
		});
	}

	public async cancelOrder(orderId: BN): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(await this.getCancelOrderIx(orderId)),
			[],
			this.opts
		);
	}

	public async getCancelOrderIx(orderId: BN): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsAccountPublicKey =
			await this.getUserPositionsAccountPublicKey();

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();

		const order = this.getOrder(orderId);
		const oracle = this.getMarketAccount(order.marketIndex).amm.oracle;

		const remainingAccounts = [];
		(await this.getUserMarketPublicKeys()).forEach((marketPublicKey) => {
			remainingAccounts.push({
				pubkey: marketPublicKey,
				isWritable: false,
				isSigner: false,
			});
		});

		return await this.program.instruction.cancelOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				userOrders: await this.getUserOrdersAccountPublicKey(),
				userPositions: userPositionsAccountPublicKey,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
				oracle,
			},
			remainingAccounts,
		});
	}

	public async cancelOrderByUserId(
		userOrderId: number
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(await this.getCancelOrderByUserIdIx(userOrderId)),
			[],
			this.opts
		);
	}

	public async getCancelOrderByUserIdIx(
		userOrderId: number
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsPublicKey =
			await this.getUserPositionsAccountPublicKey();

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();

		const order = this.getOrderByUserId(userOrderId);
		const oracle = this.getMarketAccount(order.marketIndex).amm.oracle;

		const remainingAccounts = [];
		(await this.getUserMarketPublicKeys()).forEach((marketPublicKey) => {
			remainingAccounts.push({
				pubkey: marketPublicKey,
				isWritable: false,
				isSigner: false,
			});
		});

		return await this.program.instruction.cancelOrderByUserId(userOrderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				userOrders: await this.getUserOrdersAccountPublicKey(),
				userPositions: userPositionsPublicKey,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
				oracle,
			},
			remainingAccounts,
		});
	}

	public async cancelAllOrders(
		bestEffort?: boolean
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(await this.getCancelAllOrdersIx(bestEffort)),
			[],
			this.opts
		);
	}

	public async getCancelAllOrdersIx(
		bestEffort?: boolean
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsPublicKey =
			await this.getUserPositionsAccountPublicKey();

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();

		const remainingAccounts = [];
		(await this.getUserMarketPublicKeys()).forEach((marketPublicKey) => {
			remainingAccounts.push({
				pubkey: marketPublicKey,
				isWritable: false,
				isSigner: false,
			});
		});

		for (const order of this.getUserOrdersAccount().orders) {
			const oracle = this.getMarketAccount(order.marketIndex).amm.oracle;
			remainingAccounts.push({
				pubkey: oracle,
				isWritable: false,
				isSigner: false,
			});
		}

		return await this.program.instruction.cancelAllOrders(bestEffort, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				userOrders: await this.getUserOrdersAccountPublicKey(),
				userPositions: userPositionsPublicKey,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
			},
			remainingAccounts,
		});
	}

	public async cancelOrdersByMarketAndSide(
		bestEffort?: boolean,
		marketIndexOnly?: BN,
		directionOnly?: PositionDirection
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getCancelOrdersByMarketAndSideIx(
					bestEffort,
					marketIndexOnly,
					directionOnly
				)
			),
			[],
			this.opts
		);
	}

	public async getCancelOrdersByMarketAndSideIx(
		bestEffort?: boolean,
		marketIndexOnly?: BN,
		directionOnly?: PositionDirection
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsPublicKey =
			await this.getUserPositionsAccountPublicKey();

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();

		const remainingAccounts = [];
		(await this.getUserMarketPublicKeys()).forEach((marketPublicKey) => {
			remainingAccounts.push({
				pubkey: marketPublicKey,
				isWritable: false,
				isSigner: false,
			});
		});

		for (const order of this.getUserOrdersAccount().orders) {
			const oracle = this.getMarketAccount(order.marketIndex).amm.oracle;
			remainingAccounts.push({
				pubkey: oracle,
				isWritable: false,
				isSigner: false,
			});
		}

		return await this.program.instruction.cancelOrdersByMarketAndSide(
			bestEffort,
			marketIndexOnly,
			directionOnly,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					userOrders: await this.getUserOrdersAccountPublicKey(),
					userPositions: userPositionsPublicKey,
					fundingPaymentHistory: state.fundingPaymentHistory,
					fundingRateHistory: state.fundingRateHistory,
					orderState: await this.getOrderStatePublicKey(),
					orderHistory: orderState.orderHistory,
				},
				remainingAccounts,
			}
		);
	}

	public async fillOrder(
		userAccountPublicKey: PublicKey,
		userPositionsAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey,
		userPositions: UserPositionsAccount,
		order: Order
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getFillOrderIx(
					userAccountPublicKey,
					userPositionsAccountPublicKey,
					userOrdersAccountPublicKey,
					userPositions,
					order
				)
			),
			[],
			this.opts
		);
	}

	public async getFillOrderIx(
		userAccountPublicKey: PublicKey,
		userPositionsAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey,
		userPositions: UserPositionsAccount,
		order: Order
	): Promise<TransactionInstruction> {
		const fillerPublicKey = await this.getUserAccountPublicKey();

		const marketIndex = order.marketIndex;
		const oracle = this.getMarketAccount(marketIndex).amm.oracle;

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();

		const remainingAccounts = [
			{
				pubkey: await getMarketAddress(
					this.program.programId,
					order.marketIndex
				),
				isSigner: false,
				isWritable: true,
			},
		];
		for (const position of userPositions.positions) {
			if (
				position.marketIndex.eq(order.marketIndex) ||
				positionIsAvailable(position)
			) {
				continue;
			}

			const marketPublicKey = await getMarketPublicKey(
				this.program.programId,
				position.marketIndex
			);
			remainingAccounts.push({
				pubkey: marketPublicKey,
				isWritable: false,
				isSigner: false,
			});
		}

		if (!order.referrer.equals(PublicKey.default)) {
			remainingAccounts.push({
				pubkey: order.referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const orderId = order.orderId;
		return await this.program.instruction.fillOrder(orderId, {
			accounts: {
				state: await this.getStatePublicKey(),
				filler: fillerPublicKey,
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				userPositions: userPositionsAccountPublicKey,
				userOrders: userOrdersAccountPublicKey,
				tradeHistory: state.tradeHistory,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
				extendedCurveHistory: state.extendedCurveHistory,
				oracle: oracle,
			},
			remainingAccounts,
		});
	}

	public async initializeUserOrdersThenPlaceAndFillOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		const instructions: anchor.web3.TransactionInstruction[] = [];
		const userOrdersAccountExists = this.userOrdersAccountExists();
		if (!userOrdersAccountExists) {
			instructions.push(await this.getInitializeUserOrdersInstruction());
		}
		instructions.push(
			await this.getPlaceAndFillOrderIx(orderParams, discountToken, referrer)
		);
		const tx = new Transaction();
		for (const instruction of instructions) {
			tx.add(instruction);
		}

		return await this.txSender.send(tx, [], this.opts);
	}

	public async placeAndFillOrder(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getPlaceAndFillOrderIx(orderParams, discountToken, referrer)
			),
			[],
			this.opts
		);
	}

	public async getPlaceAndFillOrderIx(
		orderParams: OrderParams,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsAccountPublicKey =
			await this.getUserPositionsAccountPublicKey();

		const priceOracle = this.getMarketAccount(orderParams.marketIndex).amm
			.oracle;

		const remainingAccounts = [
			{
				pubkey: await getMarketAddress(
					this.program.programId,
					orderParams.marketIndex
				),
				isSigner: false,
				isWritable: true,
			},
		];
		(await this.getUserMarketPublicKeys(orderParams.marketIndex)).forEach(
			(marketPublicKey) => {
				remainingAccounts.push({
					pubkey: marketPublicKey,
					isWritable: false,
					isSigner: false,
				});
			}
		);

		if (orderParams.optionalAccounts.discountToken) {
			if (!discountToken) {
				throw Error(
					'Optional accounts specified discount token but no discount token present'
				);
			}

			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}

		if (orderParams.optionalAccounts.referrer) {
			if (!referrer) {
				throw Error(
					'Optional accounts specified referrer but no referrer present'
				);
			}

			remainingAccounts.push({
				pubkey: referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const state = this.getStateAccount();
		const orderState = this.getOrderStateAccount();
		return await this.program.instruction.placeAndFillOrder(orderParams, {
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccountPublicKey,
				authority: this.wallet.publicKey,
				userOrders: await this.getUserOrdersAccountPublicKey(),
				userPositions: userPositionsAccountPublicKey,
				tradeHistory: state.tradeHistory,
				fundingPaymentHistory: state.fundingPaymentHistory,
				fundingRateHistory: state.fundingRateHistory,
				orderState: await this.getOrderStatePublicKey(),
				orderHistory: orderState.orderHistory,
				extendedCurveHistory: state.extendedCurveHistory,
				oracle: priceOracle,
			},
			remainingAccounts,
		});
	}

	/**
	 * Close an entire position. If you want to reduce a position, use the {@link openPosition} method in the opposite direction of the current position.
	 * @param marketIndex
	 * @param discountToken
	 * @param referrer
	 * @returns
	 */
	public async closePosition(
		marketIndex: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		return await this.txSender.send(
			wrapInTx(
				await this.getClosePositionIx(marketIndex, discountToken, referrer)
			),
			[],
			this.opts
		);
	}

	public async getClosePositionIx(
		marketIndex: BN,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();
		const userPositionsAccountPublicKey =
			await this.getUserPositionsAccountPublicKey();

		const priceOracle = this.getMarketAccount(marketIndex).amm.oracle;

		const remainingAccounts = [
			{
				pubkey: await getMarketAddress(this.program.programId, marketIndex),
				isSigner: false,
				isWritable: true,
			},
		];
		(await this.getUserMarketPublicKeys(marketIndex)).forEach(
			(marketPublicKey) => {
				remainingAccounts.push({
					pubkey: marketPublicKey,
					isWritable: false,
					isSigner: false,
				});
			}
		);

		const optionalAccounts = {
			discountToken: false,
			referrer: false,
		};

		if (discountToken) {
			optionalAccounts.discountToken = true;
			remainingAccounts.push({
				pubkey: discountToken,
				isWritable: false,
				isSigner: false,
			});
		}
		if (referrer) {
			optionalAccounts.referrer = true;
			remainingAccounts.push({
				pubkey: referrer,
				isWritable: true,
				isSigner: false,
			});
		}

		const state = this.getStateAccount();
		return await this.program.instruction.closePosition(
			marketIndex,
			optionalAccounts,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					user: userAccountPublicKey,
					authority: this.wallet.publicKey,
					userPositions: userPositionsAccountPublicKey,
					tradeHistory: state.tradeHistory,
					fundingPaymentHistory: state.fundingPaymentHistory,
					fundingRateHistory: state.fundingRateHistory,
					oracle: priceOracle,
				},
				remainingAccounts: remainingAccounts,
			}
		);
	}

	public async closeAllPositions(
		userPositionsAccount: UserPositionsAccount,
		discountToken?: PublicKey,
		referrer?: PublicKey
	): Promise<TransactionSignature> {
		const ixs: TransactionInstruction[] = [];
		for (const userPosition of userPositionsAccount.positions) {
			if (userPosition.baseAssetAmount.eq(ZERO)) {
				continue;
			}

			ixs.push(
				await this.getClosePositionIx(
					userPosition.marketIndex,
					discountToken,
					referrer
				)
			);
		}

		const tx = new Transaction().add(...ixs);

		return this.txSender.send(tx, [], this.opts);
	}

	public async liquidate(
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(await this.getLiquidateIx(liquidateeUserAccountPublicKey)),
			[],
			this.opts
		);
	}

	public async getLiquidateIx(
		liquidateeUserAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const userAccountPublicKey = await this.getUserAccountPublicKey();

		const liquidateePositionsPublicKey = await getUserPositionsAccountPublicKey(
			this.program.programId,
			liquidateeUserAccountPublicKey
		);
		const liquidateePositions: any =
			await this.program.account.userPositions.fetch(
				liquidateePositionsPublicKey
			);

		const marketAccountInfos = [];
		const oracleAccountInfos = [];
		for (const position of liquidateePositions.positions) {
			if (!positionIsAvailable(position)) {
				const market = this.getMarketAccount(position.marketIndex);
				const marketPublicKey = await getMarketPublicKey(
					this.program.programId,
					position.marketIndex
				);
				marketAccountInfos.push({
					pubkey: marketPublicKey,
					isWritable: true,
					isSigner: false,
				});
				oracleAccountInfos.push({
					pubkey: market.amm.oracle,
					isWritable: false,
					isSigner: false,
				});
			}
		}
		const remainingAccounts = marketAccountInfos.concat(oracleAccountInfos);

		const state = this.getStateAccount();
		return await this.program.instruction.liquidate({
			accounts: {
				state: await this.getStatePublicKey(),
				authority: this.wallet.publicKey,
				user: liquidateeUserAccountPublicKey,
				liquidator: userAccountPublicKey,
				collateralVault: state.collateralVault,
				collateralVaultAuthority: state.collateralVaultAuthority,
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				tokenProgram: TOKEN_PROGRAM_ID,
				userPositions: liquidateePositionsPublicKey,
				tradeHistory: state.tradeHistory,
				liquidationHistory: state.liquidationHistory,
				fundingPaymentHistory: state.fundingPaymentHistory,
			},
			remainingAccounts: remainingAccounts,
		});
	}

	public async updateFundingRate(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(await this.getUpdateFundingRateIx(oracle, marketIndex)),
			[],
			this.opts
		);
	}

	public async getUpdateFundingRateIx(
		oracle: PublicKey,
		marketIndex: BN
	): Promise<TransactionInstruction> {
		const state = this.getStateAccount();
		return await this.program.instruction.updateFundingRate(marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
				oracle: oracle,
				fundingRateHistory: state.fundingRateHistory,
			},
		});
	}

	public async settleFundingPayment(
		userAccount: PublicKey,
		userPositionsAccountPublicKey: PublicKey
	): Promise<TransactionSignature> {
		return this.txSender.send(
			wrapInTx(
				await this.getSettleFundingPaymentIx(
					userAccount,
					userPositionsAccountPublicKey
				)
			),
			[],
			this.opts
		);
	}

	public async getSettleFundingPaymentIx(
		userAccount: PublicKey,
		userPositionsAccountPublicKey: PublicKey
	): Promise<TransactionInstruction> {
		const state = this.getStateAccount();
		const liquidateePositions: any =
			await this.program.account.userPositions.fetch(
				userPositionsAccountPublicKey
			);

		const remainingAccounts = [];
		for (const position of liquidateePositions.positions) {
			if (!positionIsAvailable(position)) {
				const marketPublicKey = await getMarketPublicKey(
					this.program.programId,
					position.marketIndex
				);
				remainingAccounts.push({
					pubkey: marketPublicKey,
					isWritable: false,
					isSigner: false,
				});
			}
		}

		return await this.program.instruction.settleFundingPayment({
			accounts: {
				state: await this.getStatePublicKey(),
				user: userAccount,
				userPositions: userPositionsAccountPublicKey,
				fundingPaymentHistory: state.fundingPaymentHistory,
			},
			remainingAccounts,
		});
	}

	public triggerEvent(eventName: keyof ClearingHouseAccountEvents, data?: any) {
		this.eventEmitter.emit(eventName, data);
	}
}
