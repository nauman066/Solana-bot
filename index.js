require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const bot = new Telegraf(process.env.BOT_TOKEN);
const connection = new Connection('https://api.mainnet-beta.solana.com');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

bot.start((ctx) => ctx.reply('Nauman Sniper Bot LIVE hai bhai! 🚀\n/buy 0.004 50 token1,token2'));

bot.command('buy', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 4) return ctx.reply('Galat format!\nExample: /buy 0.004 50 token1,token2');

  const sol = parseFloat(args[1]);
  const slip = parseInt(args[2]);
  const tokens = args.slice(3).join('').split(',');

  ctx.reply(`Sniping \( {tokens.length} tokens with \){sol} SOL each...`);

  const buys = tokens.map(async (token) => {
    try {
      const q = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=\( {token}&amount= \){Math.floor(sol*1e9)}&slippageBps=${slip*100}`);
      const quote = await q.json();
      const s = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
      });
      const swap = await s.json();
      const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
      tx.sign([wallet]);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      return `Bought \( {token.slice(0,6)}...: https://solscan.io/tx/ \){sig}`;
    } catch (e) {
      return `Failed \( {token.slice(0,6)}...: \){e.message.slice(0,40)}`;
    }
  });

  const results = await Promise.all(buys);
  results.forEach(r => ctx.reply(r));
});

bot.launch();
console.log('Nauman Sniper Bot is running!');
// Render ke liye fake server – bot ko kuch nahi hoga
const PORT = process.env.PORT || 3000;
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Nauman Sniper Bot Live Hai!');
}).listen(PORT);
console.log(`Fake server running on port ${PORT}`);
