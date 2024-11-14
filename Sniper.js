const { Connection, PublicKey } = require('@solana/web3.js');
require('dotenv').config();

class Sniper {
    constructor(config) {
        this.baseToken = config.baseToken;
        this.targetToken = config.targetToken;
        this.buyAmount = config.buyAmount;
        this.sellTargetPercentage = config.sellTargetPrice;
        this.tokenData = config.tokenData;
        this.connection = new Connection(process.env.SOLANA_WS_URL, 'confirmed');
        this.K = Number(config.tokenData.K) / 1000000000000000;
        this.V = parseFloat(config.tokenData.V);
        this.calculatedSellPrice = this.V * (1 + (this.sellTargetPercentage / 100));
        this.vaultSubscriptionId = null;
    }

    setBuyAmount(amount) {
        this.buyAmount = amount;
    }

    setSellTargetPrice(percentage) {
        this.sellTargetPercentage = percentage;
        this.calculatedSellPrice = this.V * (1 + (percentage / 100));
    }

    async watchPrice() {
        console.log(`Watching price for target token: ${this.targetToken}`);
        console.log(`Initial price (V): ${this.V}`);
        console.log(`Target sell price (${this.sellTargetPercentage}% increase): ${this.calculatedSellPrice}`);

        const intervalId = setInterval(async () => {
            const currentPrice = await this.getCurrentPrice();
            console.log(`Current price of ${this.targetToken}: ${currentPrice}`);
            if (currentPrice >= this.calculatedSellPrice) {
                await this.sellToken();
                clearInterval(intervalId);
            }
        }, 60000);
    }

    async getCurrentPrice() {
        // Fetch the current liquidity pool balance from pcVault
        const currentBalance = await this.getLiquidityBalance(); // Replace with the actual logic
        return this.calculatePrice(currentBalance);
    }

    calculatePrice(currentBalance) {
        const X = this.K / currentBalance;
        const price = currentBalance / X;
        return price;
    }

    async getLiquidityBalance() {
        const solVault = new PublicKey(this.tokenData.solVault);
        const accountInfo = await this.connection.getAccountInfo(solVault);
        if (accountInfo) {
            const balance = accountInfo.lamports / 10 ** 9;
            return balance;
        }
        throw new Error(`Unable to fetch liquidity balance for solVault ${this.tokenData.solVault}`);
    }

    async buyToken() {
        console.log(`Buying ${this.buyAmount} of target token: ${this.targetToken}`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate buy delay
        console.log(`Bought ${this.buyAmount} of ${this.targetToken}`);
    }

    async sellToken() {
        console.log(`Selling target token: ${this.targetToken}`);
        console.log(`Target price reached: ${this.calculatedSellPrice} (${this.sellTargetPercentage}% increase from V)`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`Successfully sold ${this.targetToken}`);
        console.log(`Stopping price monitoring for ${this.targetToken}`);
    }

    async subscribeToVault() {
        const solVault = new PublicKey(this.tokenData.solVault);
        this.vaultSubscriptionId = this.connection.onAccountChange(solVault, (accountInfo) => {
            const balance = accountInfo.lamports / 10 ** 9;
            console.log(`Updated balance for solVault ${this.tokenData.solVault}: ${balance}`);
            const price = this.calculatePrice(balance);
            console.log(`Calculated price based on updated balance: ${price}`);

            if (price >= this.calculatedSellPrice) {
                this.sellToken()
                    .then(() => this.unsubscribeFromVault())
                    .catch(error => console.error('Error during sale:', error));
            }
        });
        console.log(`Subscribed to account changes for solVault ${this.tokenData.solVault}`);
    }

    async unsubscribeFromVault() {
        if (this.vaultSubscriptionId) {
            try {
                await this.connection.removeAccountChangeListener(this.vaultSubscriptionId);
                console.log(`Unsubscribed from vault ${this.tokenData.solVault}`);
                this.vaultSubscriptionId = null;
            } catch (error) {
                console.error('Error unsubscribing from vault:', error);
            }
        }
    }
}

module.exports = Sniper;