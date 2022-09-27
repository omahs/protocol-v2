import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { BASE_PRECISION, BN } from '../sdk';

import {
	getFeedData,
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	initializeQuoteSpotMarket,
	initUserAccounts,
	sleep,
} from './testHelpers';

import {
	calculateReservePrice,
	PEG_PRECISION,
	PositionDirection,
	convertToNumber,
} from '../sdk';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	PRICE_PRECISION,
	FUNDING_RATE_BUFFER_PRECISION,
	ClearingHouse,
	ClearingHouseUser,
	QUOTE_SPOT_MARKET_INDEX,
} from '../sdk/src';

async function updateFundingRateHelper(
	clearingHouse: ClearingHouse,
	marketIndex: number,
	priceFeedAddress: PublicKey,
	prices: Array<number>
) {
	for (let i = 0; i < prices.length; i++) {
		await new Promise((r) => setTimeout(r, 1000)); // wait 1 second

		const newprice = prices[i];
		setFeedPrice(anchor.workspace.Pyth, newprice, priceFeedAddress);

		const marketData0 = clearingHouse.getPerpMarketAccount(marketIndex);
		const ammAccountState0 = marketData0.amm;
		const oraclePx0 = await getFeedData(
			anchor.workspace.Pyth,
			ammAccountState0.oracle
		);

		const priceSpread0 =
			convertToNumber(ammAccountState0.lastMarkPriceTwap) -
			convertToNumber(
				ammAccountState0.historicalOracleData.lastOraclePriceTwap
			);
		const frontEndFundingCalc0 = priceSpread0 / oraclePx0.twap / (24 * 3600);

		console.log(
			'funding rate frontend calc0:',
			frontEndFundingCalc0,
			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber() /
				PRICE_PRECISION.toNumber(),
			'markTwap0:',
			ammAccountState0.lastMarkPriceTwap.toNumber(),
			'oracleTwap0(vamm):',
			ammAccountState0.historicalOracleData.lastOraclePriceTwap.toNumber(),
			'oracleTwap0:',
			oraclePx0.twap,
			'oraclePrice',
			oraclePx0.price,
			'priceSpread',
			priceSpread0
		);

		const cumulativeFundingRateLongOld =
			ammAccountState0.cumulativeFundingRateLong;
		const cumulativeFundingRateShortOld =
			ammAccountState0.cumulativeFundingRateShort;
		try {
			const _tx = await clearingHouse.updateFundingRate(
				priceFeedAddress,
				marketIndex
			);
		} catch (e) {
			console.error(e);
		}

		const CONVERSION_SCALE = FUNDING_RATE_BUFFER_PRECISION.mul(PRICE_PRECISION);

		const marketData = clearingHouse.getPerpMarketAccount(marketIndex);
		const ammAccountState = marketData.amm;
		const peroidicity = marketData.amm.fundingPeriod;

		const lastFundingRate = convertToNumber(
			ammAccountState.lastFundingRate,
			CONVERSION_SCALE
		);

		console.log('last funding rate:', lastFundingRate);
		console.log(
			'cumfunding rate:',
			convertToNumber(ammAccountState.cumulativeFundingRate, CONVERSION_SCALE),
			'cumfunding rate long',
			convertToNumber(
				ammAccountState.cumulativeFundingRateLong,
				CONVERSION_SCALE
			),
			'cumfunding rate short',
			convertToNumber(
				ammAccountState.cumulativeFundingRateShort,
				CONVERSION_SCALE
			)
		);

		const lastFundingLong = ammAccountState.cumulativeFundingRateLong
			.sub(cumulativeFundingRateLongOld)
			.abs();
		const lastFundingShort = ammAccountState.cumulativeFundingRateShort
			.sub(cumulativeFundingRateShortOld)
			.abs();

		assert(ammAccountState.lastFundingRate.abs().gte(lastFundingLong.abs()));
		assert(ammAccountState.lastFundingRate.abs().gte(lastFundingShort.abs()));

		const priceSpread =
			(ammAccountState.lastMarkPriceTwap.toNumber() -
				ammAccountState.historicalOracleData.lastOraclePriceTwap.toNumber()) /
			PRICE_PRECISION.toNumber();
		const frontEndFundingCalc =
			priceSpread / ((24 * 3600) / Math.max(1, peroidicity.toNumber()));

		console.log(
			'funding rate frontend calc:',
			frontEndFundingCalc,
			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber() / PRICE_PRECISION.toNumber(),
			'markTwap:',
			ammAccountState.lastMarkPriceTwap.toNumber(),
			'oracleTwap(vamm):',
			ammAccountState.historicalOracleData.lastOraclePriceTwap.toNumber(),
			'priceSpread:',
			priceSpread
		);
		const s = new Date(ammAccountState.lastMarkPriceTwapTs.toNumber() * 1000);
		const sdate = s.toLocaleDateString('en-US');
		const stime = s.toLocaleTimeString('en-US');

		console.log('funding rate timestamp:', sdate, stime);

		// assert(Math.abs(frontEndFundingCalc - lastFundingRate) < 9e-6);
	}
}

describe('pyth-oracle', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;

	anchor.setProvider(provider);
	const program = anchor.workspace.Pyth;

	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouse2: ClearingHouse;

	let usdcMint: Keypair;
	let userUSDCAccount: Keypair;

	const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13);
	const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13);

	const usdcAmount = new BN(10 * 10 ** 6);

	let userAccount: ClearingHouseUser;
	let userAccount2: ClearingHouseUser;
	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const price = 50000;
		await mockOracle(price, -6);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			perpMarketIndexes: [0, 1],
			spotMarketIndexes: [0],
		});
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		await clearingHouse.initializeUserAccount();
		userAccount = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await userAccount.subscribe();

		await clearingHouse.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);

		// create <NUM_USERS> users with 10k that collectively do <NUM_EVENTS> actions
		const [_userUSDCAccounts, _user_keys, clearingHouses, userAccountInfos] =
			await initUserAccounts(1, usdcMint, usdcAmount, provider, [0, 1], [0]);

		clearingHouse2 = clearingHouses[0];
		userAccount2 = userAccountInfos[0];

		// await clearingHouse.depositCollateral(
		// 	await userAccount2.getPublicKey(),
		// 	usdcAmount,
		// 	userUSDCAccounts[1].publicKey
		// );
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();

		await clearingHouse2.unsubscribe();
		await userAccount2.unsubscribe();
	});

	it('change feed price', async () => {
		const price = 50000;
		const expo = -9;
		const priceFeedAddress = await mockOracle(price, expo);

		const feedDataBefore = await getFeedData(program, priceFeedAddress);
		assert.ok(feedDataBefore.price === price);
		assert.ok(feedDataBefore.exponent === expo);
		const newPrice = 55000;

		await setFeedPrice(program, newPrice, priceFeedAddress);
		const feedDataAfter = await getFeedData(program, priceFeedAddress);
		assert.ok(feedDataAfter.price === newPrice);
		assert.ok(feedDataAfter.exponent === expo);
	});

	it('oracle/vamm: funding rate calc 0hour periodicity', async () => {
		const priceFeedAddress = await mockOracle(40, -10);
		const periodicity = new BN(0); // 1 HOUR
		const marketIndex = 0;

		await clearingHouse.initializeMarket(
			priceFeedAddress,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(39.99 * PEG_PRECISION.toNumber())
		);

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			priceFeedAddress,
			[42]
		);
	});

	it('oracle/vamm: funding rate calc2 0hour periodicity', async () => {
		const priceFeedAddress = await mockOracle(40, -10);
		const periodicity = new BN(0);
		const marketIndex = 1;

		await clearingHouse.initializeMarket(
			priceFeedAddress,
			ammInitialBaseAssetAmount,
			ammInitialQuoteAssetAmount,
			periodicity,
			new BN(41.7 * PEG_PRECISION.toNumber())
		);

		// await clearingHouse.moveAmmToPrice(
		// 	marketIndex,
		// 	new BN(41.5 * PRICE_PRECISION.toNumber())
		// );

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			priceFeedAddress,
			[41.501, 41.499]
		);
	});

	it('oracle/vamm: asym funding rate calc 0hour periodicity', async () => {
		const marketIndex = 1;

		// await clearingHouse.moveAmmToPrice(
		// 	marketIndex,
		// 	new BN(41.5 * PRICE_PRECISION.toNumber())
		// );

		console.log(
			'PRICE',
			convertToNumber(
				calculateReservePrice(clearingHouse.getPerpMarketAccount(marketIndex))
			)
		);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION,
			marketIndex
		);

		await clearingHouse2.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION.div(new BN(100)),
			marketIndex
		);
		await clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);

		console.log('PRICE AFTER', convertToNumber(calculateReservePrice(market)));

		await updateFundingRateHelper(
			clearingHouse,
			marketIndex,
			market.amm.oracle,
			[43.501, 44.499]
		);
		await sleep(1000);
		await clearingHouse.fetchAccounts();

		const marketNew = clearingHouse.getPerpMarketAccount(marketIndex);

		console.log(
			'lastOraclePriceTwap before:',
			market.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		console.log(
			'lastMarkPriceTwap before:',
			market.amm.lastMarkPriceTwap.toString()
		);

		console.log(
			'lastOraclePriceTwap after:',
			marketNew.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		console.log(
			'lastMarkPriceTwap after:',
			marketNew.amm.lastMarkPriceTwap.toString()
		);

		const fundingRateLong = marketNew.amm.cumulativeFundingRateLong.sub(
			market.amm.cumulativeFundingRateLong
		);
		console.log(
			marketNew.amm.cumulativeFundingRateLong.toString(),
			market.amm.cumulativeFundingRateLong.toString(),
			marketNew.amm.cumulativeFundingRateShort.toString(),
			market.amm.cumulativeFundingRateShort.toString()
		);
		const fundingRateShort = marketNew.amm.cumulativeFundingRateShort.sub(
			market.amm.cumulativeFundingRateShort
		);

		// more dollars long than short
		console.log(fundingRateLong.toString(), 'vs', fundingRateShort.toString());
		assert(fundingRateLong.lt(new BN(0)));
		assert(fundingRateShort.lt(new BN(0))); // Z-TODO
		assert(fundingRateShort.abs().gt(fundingRateLong.abs()));
	});
});
