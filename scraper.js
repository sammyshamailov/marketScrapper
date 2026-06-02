#!/usr/bin/env node
/**
 * scraper.js — Automated market data fetcher
 *
 * Fetches stock quotes and fundamentals from Yahoo Finance and the
 * Robinhood public API, then writes the results to data/stocks.json.
 *
 * Tickers to scrape can be supplied via the TICKERS environment variable
 * (comma-separated), e.g.:  TICKERS=AAPL,MSFT,MRVL node scraper.js
 * If TICKERS is not set the DEFAULT_TICKERS list below is used.
 *
 * Requires Node.js >= 18 (native globalThis.fetch).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'MRVL'];

const TICKERS = process.env.TICKERS
  ? process.env.TICKERS.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
  : DEFAULT_TICKERS;

const OUTPUT_DIR  = path.join(__dirname, 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'stocks.json');

const REQUEST_TIMEOUT_MS = 15_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatLargeNumber(value) {
  const num = parseFloat(value);
  if (isNaN(num)) return null;
  if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9)  return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6)  return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3)  return `${(num / 1e3).toFixed(2)}K`;
  return num.toFixed(2);
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'marketScrapper/1.0 (github-actions)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Data Sources ──────────────────────────────────────────────────────────────

/**
 * Fetch quote + fundamentals from Yahoo Finance Chart API.
 * Returns null if the ticker cannot be resolved.
 */
async function fetchYahooFinance(ticker) {
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`;
    const data = await fetchJSON(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const prevClose  = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const price      = meta.regularMarketPrice ?? null;
    const pctChange  = (price && prevClose)
      ? `${((price - prevClose) / prevClose * 100).toFixed(2)}%`
      : null;

    return {
      source:        'yahoo_finance',
      ticker:        meta.symbol || ticker,
      companyName:   meta.longName || meta.shortName || ticker,
      currency:      meta.currency || 'USD',
      price,
      previousClose: prevClose,
      pctChange,
      marketCap:     meta.marketCap ? formatLargeNumber(meta.marketCap) : null,
      exchange:      meta.exchangeName || null,
    };
  } catch (err) {
    console.warn(`  [WARN] Yahoo Finance failed for ${ticker}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch quote from the public Robinhood quotes endpoint.
 * Returns null if blocked or unavailable.
 */
async function fetchRobinhoodQuote(ticker) {
  try {
    const url  = `https://api.robinhood.com/quotes/${ticker}/`;
    const data = await fetchJSON(url);
    if (!data || data.detail) return null; // detail field signals an error

    const price      = data.last_extended_hours_trade_price
      ? parseFloat(data.last_extended_hours_trade_price)
      : (data.last_trade_price ? parseFloat(data.last_trade_price) : null);
    const prevClose  = data.previous_close ? parseFloat(data.previous_close) : null;
    const pctChange  = (price && prevClose)
      ? `${((price - prevClose) / prevClose * 100).toFixed(2)}%`
      : null;

    return {
      source:        'robinhood',
      ticker:        data.symbol || ticker,
      price,
      previousClose: prevClose,
      pctChange,
      bidPrice:      data.bid_price ? parseFloat(data.bid_price) : null,
      askPrice:      data.ask_price ? parseFloat(data.ask_price) : null,
    };
  } catch (err) {
    console.warn(`  [WARN] Robinhood quote failed for ${ticker}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch fundamentals from the public Robinhood fundamentals endpoint.
 * Returns null if blocked or unavailable.
 */
async function fetchRobinhoodFundamentals(ticker) {
  try {
    const url  = `https://api.robinhood.com/fundamentals/${ticker}/`;
    const data = await fetchJSON(url);
    if (!data || data.detail) return null;

    return {
      marketCap:      data.market_cap      ? formatLargeNumber(data.market_cap)      : null,
      peRatio:        data.pe_ratio        ? parseFloat(data.pe_ratio).toFixed(2)    : null,
      pbRatio:        data.pb_ratio        ? parseFloat(data.pb_ratio).toFixed(2)    : null,
      dividendYield:  data.dividend_yield  ? parseFloat(data.dividend_yield).toFixed(4) : null,
      high52Weeks:    data.high_52_weeks   ? parseFloat(data.high_52_weeks).toFixed(2)  : null,
      low52Weeks:     data.low_52_weeks    ? parseFloat(data.low_52_weeks).toFixed(2)   : null,
      averageVolume:  data.average_volume  ? formatLargeNumber(data.average_volume)  : null,
      sector:         data.sector          || null,
      industry:       data.industry        || null,
      ceo:            data.ceo             || null,
      employees:      data.num_employees   || null,
      yearFounded:    data.year_founded    || null,
      headquarters:   (data.headquarters_city && data.headquarters_state)
                        ? `${data.headquarters_city}, ${data.headquarters_state}`
                        : (data.headquarters_city || data.headquarters_state || null),
    };
  } catch (err) {
    console.warn(`  [WARN] Robinhood fundamentals failed for ${ticker}: ${err.message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeTicker(ticker) {
  console.log(`Scraping ${ticker}...`);

  const [yahoo, rbQuote, rbFund] = await Promise.all([
    fetchYahooFinance(ticker),
    fetchRobinhoodQuote(ticker),
    fetchRobinhoodFundamentals(ticker),
  ]);

  const price = yahoo?.price ?? rbQuote?.price ?? null;

  return {
    ticker,
    scrapedAt:   new Date().toISOString(),
    price,
    companyName: yahoo?.companyName ?? ticker,
    currency:    yahoo?.currency ?? 'USD',
    pctChange:   yahoo?.pctChange ?? rbQuote?.pctChange ?? null,
    previousClose: yahoo?.previousClose ?? rbQuote?.previousClose ?? null,
    marketCap:   yahoo?.marketCap ?? rbFund?.marketCap ?? null,
    exchange:    yahoo?.exchange ?? null,
    fundamentals: rbFund ?? null,
    sources: {
      yahooFinance:       yahoo    ? 'ok' : 'failed',
      robinhoodQuote:     rbQuote  ? 'ok' : 'failed',
      robinhoodFundamentals: rbFund ? 'ok' : 'failed',
    },
  };
}

async function main() {
  console.log(`\n=== Market Scraper ===`);
  console.log(`Tickers : ${TICKERS.join(', ')}`);
  console.log(`Output  : ${OUTPUT_FILE}`);
  console.log(`Started : ${new Date().toISOString()}\n`);

  const results = [];
  for (const ticker of TICKERS) {
    const record = await scrapeTicker(ticker);
    results.push(record);
    const status = record.price !== null ? `$${record.price}` : 'no price';
    console.log(`  ${ticker.padEnd(6)} → ${status}`);
  }

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const output = {
    generatedAt: new Date().toISOString(),
    tickers:     results,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nWrote ${results.length} records to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
