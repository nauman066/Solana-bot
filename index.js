require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Connection, PublicKey, Keypair, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);
const connection = new Connection(process.env.RPC_URL || 'https://rpc.ankr.com/solana', 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const WALLET = wallet.publicKey.toBase58();

// Token storage for P/L tracking
let tokenData = {};

// Live SOL price
let solPrice = 180;
const updateSolPrice = async () => {
  try {
    const res = await fetch('https://price.jup.ag/v6/price?ids=SOL');
    const json = await res.json();
    solPrice = json.data.SOL?.price || 180;
  } catch (e) {
    console.log('Price update failed:', e.message);
  }
};
setInterval(updateSolPrice, 60000);
updateSolPrice();

// Keep alive
setInterval(() => fetch(process.env.RENDER_URL || 'https://your-bot.onrender.com').catch(() => {}), 300000);

// Jupiter swap function
async function jupiterSwap(inputAmount, outputMint, slippageBps) {
  try {
    // Get quote
    const quoteResponse = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${outputMint}&amount=${inputAmount}&slippageBps=${slippageBps}`
    );
    const quoteData = await quoteResponse.json();
    
    if (!quoteData || quoteData.error) {
      throw new Error(quoteData.error || 'Quote failed');
    }

    // Get transaction
    const txResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: WALLET,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevel: 'high' }
      })
    });
    
    const swapData = await txResponse.json();
    if (!swapData.swapTransaction) {
      throw new Error('Transaction creation failed');
    }

    // Deserialize transaction
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    // Sign and send
    transaction.sign([wallet]);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 2
    });
    
    // Confirm transaction
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new Error('Transaction failed');
    }

    return {
      success: true,
      signature,
      inputAmount: quoteData.inputAmount,
      outputAmount: quoteData.outAmount,
      pricePerToken: (quoteData.inputAmount / quoteData.outAmount) * (10 ** quoteData.outputDecimals)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get token balance
async function getTokenBalance(mintAddress) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(mintAddress)
    });
    
    if (tokenAccounts.value.length > 0) {
      return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

// Get token metadata
async function getTokenMetadata(mintAddress) {
  try {
    const response = await fetch(`https://token-api.jup.ag/token/${mintAddress}`);
    const data = await response.json();
    return {
      name: data.name || 'Unknown',
      symbol: data.symbol || mintAddress.slice(0,6),
      decimals: data.decimals || 6
    };
  } catch {
    return { name: 'Unknown', symbol: mintAddress.slice(0,6), decimals: 6 };
  }
}

// Calculate P/L
function calculateProfitLoss(mintAddress, currentPrice) {
  if (!tokenData[mintAddress]) return { usd: 0, percent: 0 };
  
  const token = tokenData[mintAddress];
  const currentValue = token.balance * currentPrice;
  const costBasis = token.totalCost;
  const profitLoss = currentValue - costBasis;
  const percent = costBasis > 0 ? ((profitLoss / costBasis) * 100) : 0;
  
  return { usd: profitLoss, percent };
}

bot.start((ctx) => {
  ctx.reply(`🚀 *Tera Dream Sniper Bot LIVE Hai!*\n\n*Commands:*\n/wallet - Wallet balance dekh\n/portfolio - Portfolio + P/L dekh\n/buy 0.01 30 token1,token2 - Multiple tokens buy kar\n\n*Example:*\n/buy 0.01 30 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,So11111111111111111111111111111111111111112`, 
    { parse_mode: 'Markdown' });
});

bot.command('wallet', async (ctx) => {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    const solBalance = balance / 1e9;
    const usdValue = solBalance * solPrice;
    
    ctx.reply(
      `💰 *Wallet Details*\n\n` +
      `📍 *Address:* \`${WALLET}\`\n` +
      `⚡ *SOL Balance:* ${solBalance.toFixed(6)} SOL\n` +
      `💵 *USD Value:* $${usdValue.toFixed(2)}\n` +
      `📈 *SOL Price:* $${solPrice.toFixed(2)}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    ctx.reply('❌ Network error, thodi der baad try karo');
  }
});

bot.command('portfolio', async (ctx) => {
  try {
    // SOL Balance
    const solBalance = await connection.getBalance(wallet.publicKey) / 1e9;
    const solValue = solBalance * solPrice;
    
    let message = `📊 *Your Portfolio*\n\n`;
    message += `⚡ *SOL:* ${solBalance.toFixed(6)} ≈ $${solValue.toFixed(2)}\n\n`;
    
    // SPL Tokens
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });
    
    let totalPortfolioValue = solValue;
    let hasTokens = false;
    
    for (const account of tokenAccounts.value) {
      const info = account.account.data.parsed.info;
      const mint = info.mint;
      const balance = info.tokenAmount.uiAmount;
      
      if (balance > 0) {
        hasTokens = true;
        const metadata = await getTokenMetadata(mint);
        const priceResponse = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
        const priceData = await priceResponse.json();
        const tokenPrice = priceData.data?.[mint]?.price || 0;
        const tokenValue = balance * tokenPrice;
        
        const pl = calculateProfitLoss(mint, tokenPrice);
        
        message += `🪙 *${metadata.symbol}:* ${balance.toFixed(4)}\n`;
        message += `   💵 Value: $${tokenValue.toFixed(2)}\n`;
        message += `   📈 P/L: $${pl.usd.toFixed(2)} (${pl.percent.toFixed(2)}%)\n\n`;
        
        totalPortfolioValue += tokenValue;
      }
    }
    
    if (!hasTokens) {
      message += `No SPL tokens found. Use /buy to start trading!`;
    } else {
      message += `💰 *Total Portfolio Value:* $${totalPortfolioValue.toFixed(2)}`;
    }
    
    ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply('❌ Portfolio load nahi ho paya, baad mein try karo');
  }
});

bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  
  if (args.length < 3) {
    return ctx.reply('❌ *Usage:* /buy <SOL_amount> <slippage_%> <token1,token2,...>\n*Example:* /buy 0.01 30 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 
      { parse_mode: 'Markdown' });
  }
  
  const [solAmount, slippagePercent, tokensList] = args;
  const tokenAddresses = tokensList.split(',');
  const inputAmount = Math.floor(parseFloat(solAmount) * 1e9);
  const slippageBps = Math.floor(parseFloat(slippagePercent) * 100);
  
  if (!inputAmount || !slippageBps || tokenAddresses.length === 0) {
    return ctx.reply('❌ Invalid parameters. Check amount, slippage and token addresses.');
  }
  
  ctx.reply(`🔄 Buying ${tokenAddresses.length} tokens with ${solAmount} SOL...`);
  
  for (const tokenAddress of tokenAddresses) {
    try {
      ctx.reply(`🔄 Processing ${tokenAddress.slice(0,8)}...`);
      
      const result = await jupiterSwap(inputAmount, tokenAddress, slippageBps);
      
      if (result.success) {
        // Save buy data for P/L tracking
        const metadata = await getTokenMetadata(tokenAddress);
        const balance = await getTokenBalance(tokenAddress);
        
        if (!tokenData[tokenAddress]) {
          tokenData[tokenAddress] = {
            balance: 0,
            totalCost: 0,
            avgPrice: 0
          };
        }
        
        const costInSOL = inputAmount / 1e9;
        tokenData[tokenAddress].balance += balance;
        tokenData[tokenAddress].totalCost += costInSOL * solPrice;
        tokenData[tokenAddress].avgPrice = tokenData[tokenAddress].totalCost / tokenData[tokenAddress].balance;
        
        const txLink = `https://solscan.io/tx/${result.signature}`;
        const currentPL = calculateProfitLoss(tokenAddress, 0); // Will update in next refresh
        
        ctx.reply(
          `✅ *Buy Successful!*\n\n` +
          `🪙 *Token:* ${metadata.symbol}\n` +
          `💰 *Amount:* ${(result.outputAmount / (10 ** metadata.decimals)).toFixed(6)}\n` +
          `💸 *Cost:* ${costInSOL.toFixed(6)} SOL\n` +
          `🔗 *Tx:* [View on Solscan](${txLink})\n` +
          `📊 *P/L:* $${currentPL.usd.toFixed(2)} (${currentPL.percent.toFixed(2)}%)`,
          { parse_mode: 'Markdown' }
        );
      } else {
        ctx.reply(`❌ Failed to buy ${tokenAddress.slice(0,8)}: ${result.error}`);
      }
      
      // Small delay between buys
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      ctx.reply(`❌ Error buying ${tokenAddress.slice(0,8)}: ${error.message}`);
    }
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Kuch error aaya, thodi der baad try karo');
});

// Start bot
bot.launch().then(() => {
  console.log('🚀 Tera Dream Sniper Bot started!');
});

// HTTP server for Render
require('http').createServer((req, res) => {
  res.writeHead(200);
  res.end('🚀 Tera Dream Sniper Bot Live Hai!');
}).listen(process.env.PORT || 3000);
