import { ZeroEx } from '0x.js';
import { BlockchainLifecycle } from '@0xproject/dev-utils';
import { TransactionReceiptWithDecodedLogs } from '@0xproject/types';
import { BigNumber } from '@0xproject/utils';
import { Web3Wrapper } from '@0xproject/web3-wrapper';
import * as chai from 'chai';

import { DummyERC20TokenContract } from '../../src/contract_wrappers/generated/dummy_e_r_c20_token';
import { DummyERC721TokenContract } from '../../src/contract_wrappers/generated/dummy_e_r_c721_token';
import { ERC20ProxyContract } from '../../src/contract_wrappers/generated/e_r_c20_proxy';
import { ERC721ProxyContract } from '../../src/contract_wrappers/generated/e_r_c721_proxy';
import { ExchangeContract } from '../../src/contract_wrappers/generated/exchange';
import { ForwarderContract } from '../../src/contract_wrappers/generated/forwarder';
import { assetProxyUtils } from '../../src/utils/asset_proxy_utils';
import { constants } from '../../src/utils/constants';
import { ERC20Wrapper } from '../../src/utils/erc20_wrapper';
import { ERC721Wrapper } from '../../src/utils/erc721_wrapper';
import { ExchangeWrapper } from '../../src/utils/exchange_wrapper';
import { ForwarderWrapper } from '../../src/utils/forwarder_wrapper';
import { OrderFactory } from '../../src/utils/order_factory';
import { AssetProxyId, ContractName, ERC20BalancesByOwner, SignedOrder } from '../../src/utils/types';
import { chaiSetup } from '../utils/chai_setup';
import { deployer } from '../utils/deployer';
import { provider, web3Wrapper } from '../utils/web3_wrapper';

chaiSetup.configure();
const expect = chai.expect;
const blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);
const DECIMALS_DEFAULT = 18;

describe.only(ContractName.Forwarder, () => {
    let makerAddress: string;
    let owner: string;
    let takerAddress: string;
    let feeRecipientAddress: string;
    let defaultTakerAssetAddress: string;
    let defaultMakerAssetAddress: string;
    const INITIAL_BALANCE = ZeroEx.toBaseUnitAmount(new BigNumber(10000), DECIMALS_DEFAULT);
    const INITIAL_ALLOWANCE = ZeroEx.toBaseUnitAmount(new BigNumber(10000), DECIMALS_DEFAULT);

    let weth: DummyERC20TokenContract;
    let erc20TokenA: DummyERC20TokenContract;
    let erc20TokenB: DummyERC20TokenContract;
    let zrxToken: DummyERC20TokenContract;
    let erc721Token: DummyERC721TokenContract;
    let forwarderContract: ForwarderContract;
    let forwarderWrapper: ForwarderWrapper;
    let erc20Proxy: ERC20ProxyContract;
    let erc721Proxy: ERC721ProxyContract;

    let signedOrder: SignedOrder;
    let signedOrders: SignedOrder[];
    let orderWithFee: SignedOrder;
    let signedOrdersWithFee: SignedOrder[];
    let feeOrder: SignedOrder;
    let feeOrders: SignedOrder[];
    let orderFactory: OrderFactory;
    let erc20Wrapper: ERC20Wrapper;
    let erc721Wrapper: ERC721Wrapper;
    let erc20Balances: ERC20BalancesByOwner;
    let tx: TransactionReceiptWithDecodedLogs;

    let erc721MakerAssetIds: BigNumber[];

    let zeroEx: ZeroEx;

    before(async () => {
        const accounts = await web3Wrapper.getAvailableAddressesAsync();
        const usedAddresses = ([owner, makerAddress, takerAddress, feeRecipientAddress] = accounts);

        erc20Wrapper = new ERC20Wrapper(deployer, provider, usedAddresses, owner);
        erc721Wrapper = new ERC721Wrapper(deployer, provider, usedAddresses, owner);

        [erc20TokenA, erc20TokenB, zrxToken] = await erc20Wrapper.deployDummyTokensAsync();
        erc20Proxy = await erc20Wrapper.deployProxyAsync();
        await erc20Wrapper.setBalancesAndAllowancesAsync();

        [erc721Token] = await erc721Wrapper.deployDummyTokensAsync();
        erc721Proxy = await erc721Wrapper.deployProxyAsync();
        await erc721Wrapper.setBalancesAndAllowancesAsync();
        const erc721Balances = await erc721Wrapper.getBalancesAsync();
        erc721MakerAssetIds = erc721Balances[makerAddress][erc721Token.address];

        const etherTokenInstance = await deployer.deployAsync(ContractName.EtherToken);
        weth = new DummyERC20TokenContract(etherTokenInstance.abi, etherTokenInstance.address, provider);
        erc20Wrapper.addDummyTokenContract(weth);

        const exchangeInstance = await deployer.deployAsync(ContractName.Exchange, [
            assetProxyUtils.encodeERC20ProxyData(zrxToken.address),
        ]);
        const exchange = new ExchangeContract(exchangeInstance.abi, exchangeInstance.address, provider);
        zeroEx = new ZeroEx(provider, {
            exchangeContractAddress: exchangeInstance.address,
            networkId: constants.TESTRPC_NETWORK_ID,
        });
        const exchangeWrapper = new ExchangeWrapper(exchange, zeroEx);
        await exchangeWrapper.registerAssetProxyAsync(AssetProxyId.ERC20, erc20Proxy.address, owner);
        await exchangeWrapper.registerAssetProxyAsync(AssetProxyId.ERC721, erc721Proxy.address, owner);

        await erc20Proxy.addAuthorizedAddress.sendTransactionAsync(exchangeInstance.address, {
            from: owner,
        });
        await erc721Proxy.addAuthorizedAddress.sendTransactionAsync(exchangeInstance.address, {
            from: owner,
        });

        defaultMakerAssetAddress = erc20TokenA.address;
        defaultTakerAssetAddress = etherTokenInstance.address;
        const defaultOrderParams = {
            exchangeAddress: exchangeInstance.address,
            makerAddress,
            feeRecipientAddress,
            makerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultMakerAssetAddress),
            takerAssetData: assetProxyUtils.encodeERC20ProxyData(defaultTakerAssetAddress),
            makerAssetAmount: ZeroEx.toBaseUnitAmount(new BigNumber(200), DECIMALS_DEFAULT),
            takerAssetAmount: ZeroEx.toBaseUnitAmount(new BigNumber(10), DECIMALS_DEFAULT),
            makerFee: ZeroEx.toBaseUnitAmount(new BigNumber(1), DECIMALS_DEFAULT),
            takerFee: ZeroEx.toBaseUnitAmount(new BigNumber(0), DECIMALS_DEFAULT),
        };
        const privateKey = constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
        orderFactory = new OrderFactory(privateKey, defaultOrderParams);

        const forwarderArgs = [
            exchangeInstance.address,
            etherTokenInstance.address,
            zrxToken.address,
            AssetProxyId.ERC20,
        ];
        const forwarderInstance = await deployer.deployAndSaveAsync(ContractName.Forwarder, forwarderArgs);
        forwarderContract = new ForwarderContract(forwarderInstance.abi, forwarderInstance.address, provider);
        await forwarderContract.setERC20ProxyApproval.sendTransactionAsync(AssetProxyId.ERC20, { from: owner });
        forwarderWrapper = new ForwarderWrapper(forwarderContract, web3Wrapper);
        erc20Wrapper.addTokenOwnerAddress(forwarderInstance.address);

        const forwarderZRXBalance = Web3Wrapper.toBaseUnitAmount(new BigNumber(1000), 18);
        const txHash = await zrxToken.transfer.sendTransactionAsync(forwarderInstance.address, forwarderZRXBalance, {
            from: owner,
        });
        await web3Wrapper.awaitTransactionMinedAsync(txHash);

        web3Wrapper.abiDecoder.addABI(forwarderContract.abi);
        web3Wrapper.abiDecoder.addABI(exchangeInstance.abi);
    });
    beforeEach(async () => {
        await blockchainLifecycle.startAsync();
        erc20Balances = await erc20Wrapper.getBalancesAsync();
        signedOrder = orderFactory.newSignedOrder();
        signedOrders = [signedOrder];
        feeOrder = orderFactory.newSignedOrder({
            makerAssetData: assetProxyUtils.encodeERC20ProxyData(zrxToken.address),
            takerFee: ZeroEx.toBaseUnitAmount(new BigNumber(1), DECIMALS_DEFAULT),
        });
        feeOrders = [feeOrder];
        orderWithFee = orderFactory.newSignedOrder({
            takerFee: ZeroEx.toBaseUnitAmount(new BigNumber(1), DECIMALS_DEFAULT),
        });
        signedOrdersWithFee = [orderWithFee];
    });
    afterEach(async () => {
        await blockchainLifecycle.revertAsync();
    });
    describe('marketBuyTokens', () => {
        it('should fill the order', async () => {
            const fillAmount = signedOrder.takerAssetAmount.div(2);
            const makerBalanceBefore = erc20Balances[makerAddress][defaultMakerAssetAddress];
            const takerBalanceBefore = erc20Balances[takerAddress][defaultMakerAssetAddress];
            feeOrders = [];
            tx = await forwarderWrapper.marketBuyTokensAsync(signedOrders, feeOrders, fillAmount, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            const makerBalanceAfter = newBalances[makerAddress][defaultMakerAssetAddress];
            const takerBalanceAfter = newBalances[takerAddress][defaultMakerAssetAddress];
            const makerTokenFillAmount = fillAmount
                .times(signedOrder.makerAssetAmount)
                .dividedToIntegerBy(signedOrder.takerAssetAmount);

            expect(makerBalanceAfter).to.be.bignumber.equal(makerBalanceBefore.minus(makerTokenFillAmount));
            expect(takerBalanceAfter).to.be.bignumber.equal(takerBalanceBefore.plus(makerTokenFillAmount));
            expect(newBalances[forwarderContract.address][weth.address]).to.be.bignumber.equal(new BigNumber(0));
        });
        it('should fill the order and perform fee abstraction', async () => {
            const fillAmount = signedOrder.takerAssetAmount.div(4);
            const takerBalanceBefore = erc20Balances[takerAddress][defaultMakerAssetAddress];
            tx = await forwarderWrapper.marketBuyTokensAsync(signedOrdersWithFee, feeOrders, fillAmount, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            const takerBalanceAfter = newBalances[takerAddress][defaultMakerAssetAddress];

            const acceptPercentage = 98;
            const acceptableThreshold = takerBalanceBefore.plus(fillAmount.times(acceptPercentage).dividedBy(100));
            const withinThreshold = takerBalanceAfter.greaterThanOrEqualTo(acceptableThreshold);
            expect(withinThreshold).to.be.true();
            expect(newBalances[forwarderContract.address][weth.address]).to.be.bignumber.equal(new BigNumber(0));
        });
    });
    describe('marketBuyTokensFee', () => {
        it('should fill the order and send fee to fee recipient', async () => {
            const initEthBalance = await web3Wrapper.getBalanceInWeiAsync(feeRecipientAddress);
            const fillAmount = signedOrder.takerAssetAmount.div(2);
            const feeProportion = 150; // 1.5%
            feeOrders = [];
            tx = await forwarderWrapper.marketBuyTokensFeeAsync(
                signedOrders,
                feeOrders,
                fillAmount,
                feeProportion,
                feeRecipientAddress,
                takerAddress,
            );
            const newBalances = await erc20Wrapper.getBalancesAsync();
            const makerBalanceBefore = erc20Balances[makerAddress][defaultMakerAssetAddress];
            const makerBalanceAfter = newBalances[makerAddress][defaultMakerAssetAddress];
            const takerBalanceAfter = newBalances[takerAddress][defaultMakerAssetAddress];
            const afterEthBalance = await web3Wrapper.getBalanceInWeiAsync(feeRecipientAddress);
            const takerBoughtAmount = takerBalanceAfter.minus(erc20Balances[takerAddress][defaultMakerAssetAddress]);

            expect(makerBalanceAfter).to.be.bignumber.equal(makerBalanceBefore.minus(takerBoughtAmount));
            expect(afterEthBalance).to.be.bignumber.equal(
                initEthBalance.plus(fillAmount.times(feeProportion).dividedBy(10000)),
            );
            expect(newBalances[forwarderContract.address][weth.address]).to.be.bignumber.equal(new BigNumber(0));
        });
        it('should fail if the fee is set too high', async () => {
            const initEthBalance = await web3Wrapper.getBalanceInWeiAsync(feeRecipientAddress);
            const fillAmount = signedOrder.takerAssetAmount.div(2);
            const feeProportion = 1500; // 15.0%
            feeOrders = [];
            try {
                tx = await forwarderWrapper.marketBuyTokensFeeAsync(
                    signedOrders,
                    feeOrders,
                    fillAmount,
                    feeProportion,
                    feeRecipientAddress,
                    takerAddress,
                );
                expect.fail(); // Never reached
            } catch (err) {
                const afterEthBalance = await web3Wrapper.getBalanceInWeiAsync(feeRecipientAddress);
                expect(afterEthBalance).to.be.bignumber.equal(initEthBalance);
            }
        });
    });
    describe('quote', () => {
        it('marketBuyTokensQuote - no fees', async () => {
            const fillAmount = signedOrder.takerAssetAmount.div(4);
            const takerBalanceBefore = erc20Balances[takerAddress][defaultMakerAssetAddress];
            const sellQuote = await forwarderWrapper.marketBuyTokensQuoteAsync([signedOrder], [], fillAmount);
            feeOrders = [];
            tx = await forwarderWrapper.marketBuyTokensAsync(signedOrders, feeOrders, fillAmount, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            const takerBalanceAfter = newBalances[takerAddress][defaultMakerAssetAddress];
            expect(takerBalanceAfter).to.be.bignumber.eq(takerBalanceBefore.plus(sellQuote.makerAssetFilledAmount));
        });
        it('marketBuyTokensQuote - fee abstraction', async () => {
            const fillAmount = signedOrder.takerAssetAmount.div(2);
            const takerBalanceBefore = erc20Balances[takerAddress][defaultMakerAssetAddress];
            const buyTokensQuote = await forwarderWrapper.marketBuyTokensQuoteAsync(
                signedOrdersWithFee,
                feeOrders,
                fillAmount,
            );
            tx = await forwarderWrapper.marketBuyTokensAsync(signedOrdersWithFee, feeOrders, fillAmount, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            const takerBalanceAfter = newBalances[takerAddress][defaultMakerAssetAddress];
            expect(takerBalanceAfter).to.be.bignumber.eq(
                takerBalanceBefore.plus(buyTokensQuote.makerAssetFilledAmount),
            );
        });
    });
    describe('buyExactTokens', () => {
        it('should buy the exact amount of tokens', async () => {
            const buyTokenAmount = signedOrder.makerAssetAmount.div(2);
            const initEthBalance = await web3Wrapper.getBalanceInWeiAsync(takerAddress);
            const balancesBefore = await erc20Wrapper.getBalancesAsync();
            const rate = signedOrder.makerAssetAmount.dividedBy(signedOrder.takerAssetAmount);
            const fillAmount = buyTokenAmount.dividedToIntegerBy(rate);
            feeOrders = [];
            tx = await forwarderWrapper.buyExactTokensAsync(
                signedOrders,
                feeOrders,
                buyTokenAmount,
                fillAmount,
                takerAddress,
            );
            const newBalances = await erc20Wrapper.getBalancesAsync();
            const takerBalanceBefore = balancesBefore[takerAddress][defaultMakerAssetAddress];
            const takerBalanceAfter = newBalances[takerAddress][defaultMakerAssetAddress];
            const afterEthBalance = await web3Wrapper.getBalanceInWeiAsync(takerAddress);
            const expectedEthBalanceAfterGasCosts = initEthBalance.minus(fillAmount).minus(tx.gasUsed);
            expect(takerBalanceAfter).to.be.bignumber.eq(takerBalanceBefore.plus(buyTokenAmount));
            expect(afterEthBalance).to.be.bignumber.eq(expectedEthBalanceAfterGasCosts);
        });
        it('should buy the exact amount of tokens and return excess ETH', async () => {
            const buyTokenAmount = signedOrder.makerAssetAmount.div(2);
            const initEthBalance = await web3Wrapper.getBalanceInWeiAsync(takerAddress);
            const balancesBefore = await erc20Wrapper.getBalancesAsync();
            const rate = signedOrder.makerAssetAmount.dividedBy(signedOrder.takerAssetAmount);
            const fillAmount = buyTokenAmount.dividedToIntegerBy(rate);
            const excessFillAmount = fillAmount.times(2);
            feeOrders = [];
            tx = await forwarderWrapper.buyExactTokensAsync(
                signedOrders,
                feeOrders,
                buyTokenAmount,
                excessFillAmount,
                takerAddress,
            );
            const newBalances = await erc20Wrapper.getBalancesAsync();
            const takerBalanceBefore = balancesBefore[takerAddress][defaultMakerAssetAddress];
            const takerBalanceAfter = newBalances[takerAddress][defaultMakerAssetAddress];
            const afterEthBalance = await web3Wrapper.getBalanceInWeiAsync(takerAddress);
            const expectedEthBalanceAfterGasCosts = initEthBalance.minus(fillAmount).minus(tx.gasUsed);
            expect(takerBalanceAfter).to.be.bignumber.eq(takerBalanceBefore.plus(buyTokenAmount));
            expect(afterEthBalance).to.be.bignumber.eq(expectedEthBalanceAfterGasCosts);
        });
        it('should buy the exact amount of tokens and with fee abstraction', async () => {
            const buyTokenAmount = signedOrder.makerAssetAmount.div(2);
            const initEthBalance = await web3Wrapper.getBalanceInWeiAsync(takerAddress);
            const balancesBefore = await erc20Wrapper.getBalancesAsync();
            const rate = signedOrder.makerAssetAmount.dividedBy(signedOrder.takerAssetAmount);
            const fillAmount = buyTokenAmount.dividedToIntegerBy(rate);
            const excessFillAmount = fillAmount.times(2);
            tx = await forwarderWrapper.buyExactTokensAsync(
                signedOrdersWithFee,
                feeOrders,
                buyTokenAmount,
                excessFillAmount,
                takerAddress,
            );
            const newBalances = await erc20Wrapper.getBalancesAsync();
            const takerBalanceBefore = balancesBefore[takerAddress][defaultMakerAssetAddress];
            const takerBalanceAfter = newBalances[takerAddress][defaultMakerAssetAddress];
            const afterEthBalance = await web3Wrapper.getBalanceInWeiAsync(takerAddress);
            const expectedEthBalanceAfterGasCosts = initEthBalance.minus(fillAmount).minus(tx.gasUsed);
            expect(takerBalanceAfter).to.be.bignumber.eq(takerBalanceBefore.plus(buyTokenAmount));
        });
        it('should buy the exact amount of tokens when buying zrx with fee abstraction', async () => {
            signedOrder = orderFactory.newSignedOrder({
                makerAssetData: assetProxyUtils.encodeERC20ProxyData(zrxToken.address),
                takerFee: ZeroEx.toBaseUnitAmount(new BigNumber(1), DECIMALS_DEFAULT),
            });
            signedOrdersWithFee = [signedOrder];
            feeOrders = [];
            const buyTokenAmount = signedOrder.makerAssetAmount.div(2);
            const initEthBalance = await web3Wrapper.getBalanceInWeiAsync(takerAddress);
            const balancesBefore = await erc20Wrapper.getBalancesAsync();
            // Rate is in ZRX which has fees so more ETH is required for the same expected amount
            const rate = signedOrder.takerAssetAmount.dividedBy(
                signedOrder.makerAssetAmount.minus(signedOrder.takerFee),
            );
            let fillAmountInZRX = buyTokenAmount;
            const feeAmountInZRX = buyTokenAmount.times(signedOrder.takerFee.dividedBy(signedOrder.takerAssetAmount));
            fillAmountInZRX = fillAmountInZRX.plus(feeAmountInZRX);
            const fillAmount = fillAmountInZRX.times(rate).round();
            tx = await forwarderWrapper.buyExactTokensAsync(
                signedOrdersWithFee,
                feeOrders,
                buyTokenAmount,
                fillAmount,
                takerAddress,
            );
            const newBalances = await erc20Wrapper.getBalancesAsync();
            const takerBalanceBefore = balancesBefore[takerAddress][zrxToken.address];
            const takerBalanceAfter = newBalances[takerAddress][zrxToken.address];
            const afterEthBalance = await web3Wrapper.getBalanceInWeiAsync(takerAddress);
            const expectedCostAfterGas = fillAmount.plus(tx.gasUsed);
            // TODO this should be calculated precisely from the returned amount of ZRX * rate + gas Used
            expect(takerBalanceAfter).to.be.bignumber.greaterThan(takerBalanceBefore.plus(buyTokenAmount));
            expect(afterEthBalance).to.be.bignumber.greaterThan(initEthBalance.minus(expectedCostAfterGas));
        });
    });
    describe('Non fungible tokens', async () => {
        it('buys non fungible tokens', async () => {
            const makerAssetId = erc721MakerAssetIds[0];
            signedOrder = orderFactory.newSignedOrder({
                makerAssetAmount: new BigNumber(1),
                makerAssetData: assetProxyUtils.encodeERC721ProxyData(erc721Token.address, makerAssetId),
            });
            feeOrders = [];
            signedOrders = [signedOrder];
            tx = await forwarderWrapper.buyNFTTokensAsync(signedOrders, feeOrders, takerAddress);
            const newOwnerTakerAsset = await erc721Token.ownerOf.callAsync(makerAssetId);
            expect(newOwnerTakerAsset).to.be.bignumber.equal(takerAddress);
        });
        it('buys non fungible tokens with fee abstraction', async () => {
            const makerAssetId = erc721MakerAssetIds[0];
            signedOrder = orderFactory.newSignedOrder({
                makerAssetAmount: new BigNumber(1),
                takerFee: ZeroEx.toBaseUnitAmount(new BigNumber(1), DECIMALS_DEFAULT),
                makerAssetData: assetProxyUtils.encodeERC721ProxyData(erc721Token.address, makerAssetId),
            });
            signedOrders = [signedOrder];
            tx = await forwarderWrapper.buyNFTTokensAsync(signedOrders, feeOrders, takerAddress);
            const newOwnerTakerAsset = await erc721Token.ownerOf.callAsync(makerAssetId);
            expect(newOwnerTakerAsset).to.be.bignumber.equal(takerAddress);
        });
        it('buys non fungible tokens with fee abstraction and pays fee to fee recipient', async () => {
            const makerAssetId = erc721MakerAssetIds[0];
            signedOrder = orderFactory.newSignedOrder({
                makerAssetAmount: new BigNumber(1),
                takerFee: ZeroEx.toBaseUnitAmount(new BigNumber(1), DECIMALS_DEFAULT),
                makerAssetData: assetProxyUtils.encodeERC721ProxyData(erc721Token.address, makerAssetId),
            });
            signedOrders = [signedOrder];
            const feeProportion = 10;
            tx = await forwarderWrapper.buyNFTTokensFeeAsync(
                signedOrders,
                feeOrders,
                feeProportion,
                feeRecipientAddress,
                takerAddress,
            );
            const newOwnerTakerAsset = await erc721Token.ownerOf.callAsync(makerAssetId);
            expect(newOwnerTakerAsset).to.be.bignumber.equal(takerAddress);
        });
    });
});