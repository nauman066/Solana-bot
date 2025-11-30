require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

const bot = new Telegraf(process.env.BOT_TOKEN);
const connection = new Connection('https://rpc.ankr.com/solana', 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const WALLET = wallet.publicKey.toBase58();

let solPrice = 180;
setInterval(async () => {
  try {
    const res = await fetch('https://price.jup.ag/v6/price?ids=SOL');
    const json = await res.json();
    solPrice = json.data.SOL?.price || 180;
  } catch {}
}, 120000);

bot.command('wallet', async (ctx) => {
  ctx.reply('Wallet check kar raha hun...');
  try {
    const bal = await Promise.race([
      connection.getBalance(wallet.publicKey),
      new Promise((_, reject) => setTimeout(() => reject('timeout'), 9000))
    ]);
    const sol = bal / 1e9;
    ctx.reply(`*Wallet Connected*\n\nAddress: \`\( {WALLET}\`\nBalance: \){sol.toFixed(6)} SOL`, { parse_mode: 'Markdown' });
  } catch {
    ctx.reply('Solana network slow hai, 10 sec baad /wallet daal');
  }
});

bot.command('portfolio', async (ctx) => {
  ctx.reply('Portfolio load kar raha hun...');
  try {
    const bal = await connection.getBalance(wallet.publicKey);
    const sol = bal / 1e9;
    let msg = `*Your Portfolio*\nSOL: ${sol.toFixed(6)} ≈ \]{(sol * solPrice).toFixed(2)}\n`;
    const tokens = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });
    if (tokens.value.length === 0) msg += '\nKoi aur token nahi';
    for (let t of tokens.value) {
      const info = t.account.data.parsed.info;
      if (info.tokenAmount.uiAmount > 0) {
        msg += `\n\( {info.tokenAmount.uiAmount} × \){info.mint.slice(0,6)}...`;
      }
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.reply('Portfolio load nahi hua, thodi der baad try kar');
  }
});

bot.start(ctx => ctx.reply(`Nauman Sniper Bot LIVE hai bhai! 🚀\n\n/wallet → balance\n/portfolio → tokens\n/buy 0.005 40 token_address`));

bot.launch();
console.log('Bot running...');

require('http').createServer((req, res) => res.end('Bot Live')).listen(process.env.PORT || 3000);
