require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);
const connection = new Connection('https://rpc.ankr.com/solana', 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const WALLET = wallet.publicKey.toBase58();

// Track karne ke liye
let buyHistory = {}; // { token: { amount: X, costSol: Y, time: Z } }

function formatNumber(num) {
  return num >= 1000 ? (num / 1000).toFixed(2) + 'K' : num.toFixed(4);
}

// SOL price (cached 2 min)
let solPrice = 180;
setInterval(async () => {
  try {
    const res = await fetch('https://price.jup.ag/v6/price?ids=SOL');
    const data = await res.json();
    solPrice = data.data.SOL?.price || 180;
  } catch {}
}, 120000);

// /wallet
bot.command('wallet', async (ctx) => {
  bot.command('wallet', async (ctx) => {
  try {
    const bal = await Promise.race([
      connection.getBalance(wallet.publicKey),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
    ]);
    const sol = bal / 1e9;
    ctx.reply(`*Wallet Connected* ✅\n\nAddress: \`\( {WALLET}\`\nBalance: \){sol.toFixed(6)} SOL ≈ $${(sol*solPrice).toFixed(2)}`, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.reply('Wallet check kar raha hun... thoda slow hai network.\n5 second baad khud /wallet daal dena.');
  }
});
// /portfolio with P/L
bot.command('portfolio', async (ctx) => {
  ctx.reply('Portfolio load kar raha hun...');
  let totalValue = 0;
  let totalCost = 0;
  let msg = `*Your Portfolio* (SOL ≈ \]{solPrice})\n\n`;

  const solBal = (await connection.getBalance(wallet.publicKey)) / 1e9;
  msg += `SOL: ${solBal.toFixed(6)} ≈ \[ {(solBal*solPrice).toFixed(2)}\n\n`;\n

  const tokens = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  });

  for (let t of tokens.value) {
    const info = t.account.data.parsed.info;
    const mint = info.mint;
    const amount = info.tokenAmount.uiAmount;
    if (amount <= 0) continue;

    const history = buyHistory[mint];
    const costSol = history ? history.costSol * amount / history.amount : 0;

    try {
      const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
      const data = await res.json();
      const price = data.data[mint]?.price || 0;
      const value = amount * price;

      totalValue += value;
      totalCost += costSol * solPrice;

      const pl = value - (costSol * solPrice);
      const plPercent = costSol > 0 ? ((pl / (costSol * solPrice)) * 100).toFixed(1) : 'N/A';

      msg += `\( {amount > 1000 ? formatNumber(amount) : amount} × \){mint.slice(0,6)}...\n`;
      msg += ` \]{value.toFixed(4)} | \( {pl >= 0 ? '+' : ''}\[ {pl.toFixed(3)} ( \){plPercent}%)\n`;
    } catch {}
  }

  const totalPL = (solBal * solPrice + totalValue) - totalCost;
  msg += `\nTotal P/L: ${totalPL >= 0 ? '+' : ''} \]{totalPL.toFixed(2)}`;
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// /buy with profit tracking + detailed error
bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 4) return ctx.reply('Galat!\nExample: /buy 0.005 40 token1,token2');

  const solAmount = parseFloat(args[1]);
  const slippage = parseInt(args[2]);
  const tokens = args.slice(3).join('').split(',').filter(t => t.length >= 32);

  const balanceLamports = await connection.getBalance(wallet.publicKey);
  const solHave = balanceLamports / 1e9;

  if (solHave < solAmount + 0.015) {
    return ctx.reply(`Balance kam hai!\nTere paas: \( {solHave.toFixed(5)} SOL\nChahiye minimum: \){(solAmount + 0.015).toFixed(3)} SOL\nWallet mein thoda aur bhej`);
  }

  ctx.reply(`Sniping \( {tokens.length} token(s) × \){solAmount} SOL...`);

  for (let token of tokens) {
    try {
      const quoteRes = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=\( {token}&amount= \){Math.floor(solAmount*1e9)}&slippageBps=${slippage*100}`);
      const quote = await quoteRes.json();

      if (quote.error) {
        ctx.reply(`Failed \( {token.slice(0,6)}...: \){quote.error}`);
        continue;
      }

      const outAmount = quote.outAmount / 1e9 * (1 - slippage/100); // approx

      const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: WALLET,
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: "auto",
          dynamicComputeUnitLimit: true
        })
      });
      const swap = await swapRes.json();

      const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
      tx.sign([wallet]);
      const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 });

      await connection.confirmTransaction(sig, 'confirmed');

      // Save buy history for P/L
      buyHistory[token] = {
        amount: outAmount,
        costSol: solAmount,
        time: Date.now()
      };

      ctx.reply(`Bought \( {token.slice(0,6)}... ✅\nAmount: ~ \){outAmount.toFixed(4)}\nCost: \( {solAmount} SOL\nTx: https://solscan.io/tx/ \){sig}\nFees: ~0.008–0.015 SOL\nProfit track ho raha hai /portfolio se dekh`);
    } catch (err) {
      const m = err.message.toLowerCase();
      if (m.includes('insufficient')) ctx.reply(`Failed ${token.slice(0,6)}...: Kam SOL hai`);
      else if (m.includes('slippage')) ctx.reply(`Failed ${token.slice(0,6)}...: Token bahut tez pump ho gaya – slippage badha`);
      else if (m.includes('route')) ctx.reply(`Failed ${token.slice(0,6)}...: Jupiter route nahi de raha`);
      else ctx.reply(`Failed \( {token.slice(0,6)}...: \){err.message.slice(0,80)}`);
    }
  }
});

bot.start((ctx) => ctx.reply(`Nauman Sniper Bot v3 LIVE hai bhai!\n\nCommands:\n/wallet → balance\n/portfolio → profit/loss\n/buy 0.005 40 token1,token2`));
// Keep bot awake on Render
setInterval(() => {
  fetch('https://YOUR-RENDER-APP-NAME.onrender.com');
}, 600000);
require('http').createServer((req, res) => res.end('Bot Live')).listen(process.env.PORT || 3000);

bot.launch();
console.log('Nauman Ultimate Sniper v3 Running!');
