require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

bot.start((ctx) => ctx.reply('Nauman Sniper Bot LIVE hai bhai! 🚀\n/buy 0.004 50 token1,token2'));

bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 4) return ctx.reply('Galat! Example: /buy 0.004 50 token1,token2');

  const solAmount = parseFloat(args[1]);
  const slippage = parseInt(args[2]);
  const tokens = args.slice(3).join('').split(',').filter(t => t.length === 44);

  if (tokens.length === 0) return ctx.reply('Valid token address daal bhai!');

  ctx.reply(`Sniping \( {tokens.length} tokens with \){solAmount} SOL each...`);

  const results = await Promise.all(tokens.map(async (token) => {
    try {
      const quote = await (await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112` +
        `&outputMint=${token}` +
        `&amount=${Math.floor(solAmount * 1e9)}` +
        `&slippageBps=${slippage * 100}` +
        `&onlyDirectRoutes=false&asLegacyTransaction=false`
      )).json();

      if (quote.error) throw new Error(quote.error);

      const swap = await (await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: "auto",
          dynamicComputeUnitLimit: true
        })
      })).json();

      const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
      tx.sign([wallet]);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3
      });

      await connection.confirmTransaction(sig, 'confirmed');

      return `Bought \( {token.slice(0,6)}...: https://solscan.io/tx/ \){sig}`;
    } catch (e) {
      return `Failed \( {token.slice(0,6)}...: \){e.message.slice(0,50)}`;
    }
  }));

  results.forEach(r => ctx.reply(r));
});

// Render ke liye fake port
const PORT = process.env.PORT || 3000;
require('http').createServer((req, res) => {
  res.writeHead(200);
  res.end('Nauman Sniper Bot Live!');
}).listen(PORT);

bot.launch();
console.log('Nauman Sniper Bot is running!');
