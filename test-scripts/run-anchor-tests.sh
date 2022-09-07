if [ "$1" != "--skip-build" ]
  then
    anchor build &&
    cp target/idl/clearing_house.json sdk/src/idl/  
fi

test_files=(
  delistMarketSim.ts
  delistMarket.ts
  liquidityProvider.ts
  insuranceFundStake.ts
  liquidateBorrow.ts
  liquidateBorrowSocialLoss.ts
  referrer.ts
  liquidatePerpPnlForDeposit.ts liquidateBorrowForPerpPnl.ts
  liquidatePerp.ts
  order.ts bankDepositWithdraw.ts prepegMarketOrderBaseAssetAmount.ts
  updateAMM.ts repegAndSpread.ts 
  clearingHouse.ts 
  ordersWithSpread.ts
  marketOrder.ts triggerOrders.ts stopLimits.ts userOrderId.ts postOnly.ts
  roundInFavorBaseAsset.ts marketOrderBaseAssetAmount.ts oracleOffsetOrders.ts
  subaccounts.ts pyth.ts userAccount.ts admin.ts updateK.ts adminWithdraw.ts
  curve.ts roundInFavor.ts cappedSymFunding.ts
)
test_files=(
      delistMarketSim.ts
  delistMarket.ts
)

test_files=(
  delistMarketBankrupt.ts
)
  
for test_file in ${test_files[@]}; do
  export ANCHOR_TEST_FILE=${test_file} && anchor test --skip-build || exit 1;
done