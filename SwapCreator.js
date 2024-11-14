const { Connection, PublicKey, Keypair, ComputeBudgetProgram } = require("@solana/web3.js");
const { MongoClient } = require("mongodb");
const bs58 = require("bs58");
require("dotenv").config();

const connection = new Connection(process.env.SOLANA_WS_URL, "confirmed");
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(process.env.RAYDIUM_AMM_PROGRAM_ID);
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111"; // Solana System Program ID
const TOKEN_PROGRAM_ID_STR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // Token Program ID
const ASSOCIATED_TOKEN_PROGRAM_ID_STR = "ATokenGPv1sfdS5qUnx9GbS6hX1TTjR1L6rT3HaZJFA"; // Associated Token Program ID
const COMPUTE_UNIT_LIMIT = 120_000; //  average today on raydium is (80,471)
const PRIORITY_RATE_MULTIPLIER = 1.3; // 30% increase as specified in Rust code

let db;
let walletKeypair;

function initializeWallet() {
    try {
        const secretKeyString = process.env.WALLET_PRIVATE_KEY; // Store your base58 private key in .env
        if (!secretKeyString) {
            throw new Error("WALLET_PRIVATE_KEY not found in environment variables");
        }

        walletKeypair = Keypair.fromSecretKey(
            bs58.decode(secretKeyString)
        );

        console.log("Wallet initialized with public key:", walletKeypair.publicKey.toString());
    } catch (error) {
        console.error("Error initializing wallet:", error.message);
        process.exit(1);
    }
}

async function connectToDatabase() {
    const mongoUri = process.env.MONGO_URI;
    const client = new MongoClient(mongoUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });
    try {
        await client.connect();
        db = client.db("bot");
        console.log("Connected to MongoDB successfully.");
        initializeWallet(); // Initialize wallet after DB connection
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

async function saveToMongo(tokenData) {
    try {
        if (!db) {
            throw new Error("Database connection is not initialized");
        }
        const collection = db.collection("raydium_lp_transactions");
        const result = await collection.insertOne(tokenData);

        if (result.acknowledged) {
            console.log("Token data saved to MongoDB:", result.insertedId);
        } else {
            console.error("Failed to save token data to MongoDB.");
        }
    } catch (error) {
        console.error("Error saving token data to MongoDB:", error.message);
    }
}

function invertCoinAndPcMint(tokenData) {
    const SPECIAL_COIN_MINT = "So11111111111111111111111111111111111111112";
    if (tokenData.coinMint === SPECIAL_COIN_MINT) {
        [tokenData.coinMint, tokenData.pcMint] = [tokenData.pcMint, tokenData.coinMint];
    }
    return tokenData;
}

async function getPriorityFee(connection, accounts) {
    try {
        const priorityFees = await connection.getRecentPrioritizationFees({
            lockedWritableAccounts: accounts
        });

        if (!priorityFees.length) {
            return 1; // Default minimal fee if no recent fees available
        }

        const recentFee = priorityFees[priorityFees.length - 1].prioritizationFee;
        return Math.floor(recentFee * PRIORITY_RATE_MULTIPLIER); // Adding 30%
    } catch (error) {
        console.error("Error getting priority fee:", error);
        return 1; // Default minimal fee on error
    }
}

function createPriorityFeeInstructions(priorityFee) {
    return [
        ComputeBudgetProgram.setComputeUnitLimit({
            units: COMPUTE_UNIT_LIMIT,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFee,
        }),
    ];
}

async function processRaydiumLpTransaction(connection, signature) {
    try {
        // Fetch the transaction details with new version handling
        const transactionDetails = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!transactionDetails) {
            console.error("No transaction details found for signature:", signature);
            return;
        }

        // Updated way to access transaction data
        const message = transactionDetails.transaction.message;

        // For newer versions of Solana
        const accounts = message.staticAccountKeys
            ? message.staticAccountKeys.map((key) => key.toString())
            : message.accountKeys.map((key) => key.toString());

        const instructions = message.compiledInstructions || message.instructions;

        if (!instructions) {
            console.error("No instructions found in transaction");
            return;
        }

        console.log("Transaction Message:", message);
        console.log("Accounts:", accounts);

        const priorityFee = await getPriorityFee(connection, accounts);
        const priorityInstructions = createPriorityFeeInstructions(priorityFee);

        console.log(`Using priority fee: ${priorityFee} with compute unit limit: ${COMPUTE_UNIT_LIMIT}`);

        // Process each instruction
        for (const ix of instructions) {
            const programId = accounts[ix.programIdIndex];

            if (programId === RAYDIUM_AMM_PROGRAM_ID.toString() && ix.data.length > 0) {
                // Extract account indices (adjusted for possible different structure)
                const accountIndices = ix.accounts || ix.accountKeyIndexes;

                if (!accountIndices) {
                    console.error("No account indices found in instruction");
                    continue;
                }

                const mint0 = accounts[accountIndices[8]]; // Base token mint
                const mint1 = accounts[accountIndices[9]]; // Quote token mint
                const lpTokenMint = accounts[accountIndices[7]]; // LP token mint
                const deployer = accounts[accountIndices[17]]; // Deployer's address
                const poolId = accounts[accountIndices[4]]; // AMM pool ID
                const baseVault = accounts[accountIndices[10]]; // Base token vault
                const quoteVault = accounts[accountIndices[11]]; // Quote token vault
                const ammAuthority = accounts[accountIndices[5]]; // AMM authority
                const ammTarget = accounts[accountIndices[13]]; // AMM target orders
                const ammOpenOrder = accounts[accountIndices[6]]; // AMM open orders

                let tokenData = {
                    programId: new PublicKey(accounts[accountIndices[0]]).toString(), // Raydium AMM Program ID
                    ammId: new PublicKey(poolId).toString(), // AMM Pool Account/ LP Account
                    ammAuthority: new PublicKey(ammAuthority).toString(), // AMM Authority Account
                    ammOpenOrders: new PublicKey(ammOpenOrder).toString(),
                    lpMint: new PublicKey(lpTokenMint).toString(), // LP Token Mint
                    tokenAddress: new PublicKey(mint0).toString(), // Base Token Mint, Other
                    solAddress: new PublicKey(mint1).toString(), // Quote Token Mint, SOL
                    tokenVault: new PublicKey(baseVault).toString(), // Base Token Vault
                    solVault: new PublicKey(quoteVault).toString(), // Quote Token Vault
                    ammTargetOrders: new PublicKey(ammTarget).toString(),
                    deployer: new PublicKey(deployer).toString(), // Deployer's Address
                    systemProgramId: SYSTEM_PROGRAM_ID, // System Program ID
                    tokenProgramId: TOKEN_PROGRAM_ID_STR, // Token Program ID
                    associatedTokenProgramId: ASSOCIATED_TOKEN_PROGRAM_ID_STR, // Associated Token Program ID
                };

                tokenData = invertCoinAndPcMint(tokenData);

                await saveToMongo(tokenData);
                return tokenData;
            }
        }
    } catch (error) {
        if (error.message.includes("Cannot read properties of undefined (reading '_bn')")) {
            console.log("Encountered '_bn' error, ignoring transaction:", signature);
        } else {
            console.error("Error fetching/processing transaction:", error.message);
        }
    }
}

module.exports = {
    connectToDatabase,
    processRaydiumLpTransaction,
    walletKeypair,
};