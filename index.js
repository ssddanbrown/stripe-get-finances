#!/usr/bin/env node

const config = require('./config');
const Stripe = require('stripe');
const fs = require("fs");
const stripe = Stripe(config.stripe_key);

const args = process.argv;

if (args.length < 4) {
    console.error(`This script must be called with a from and up-to (not including) date. For example:\n stripe-get-finance 2022-01-01 2022-02-01`);
    return;
}

const fromDateStr = args[2];
const toDateStr = args[3];
const fromDate = (new Date( fromDateStr + 'T00:00:00Z'));
const toDate = (new Date(toDateStr + 'T00:00:00Z'));
const csvHeader = [
    'id', 'date', 'type', 'amount', 'description'
].join(',');

(async function() {

    const csvItems = [];

    const timeRange = {
        gte: Math.floor(fromDate.getTime() / 1000),
        lt: Math.floor(toDate.getTime() / 1000),
    };

    const transactions = stripe.balanceTransactions.list({
        created: timeRange,
        expand: ['data.source.customer']
    });

    for await (const transaction of transactions) {
        const items = await transactionToLineItems(transaction);
        csvItems.push(...items);
    }

    const itemsByType = {};
    for (const item of csvItems) {
        if (typeof itemsByType[item.type] === 'undefined') {
            itemsByType[item.type] = [];
        }
        itemsByType[item.type].push(item);
    }

    for (const [type, items] of Object.entries(itemsByType)) {
        const csv = itemsToCsv(items);
        const csvName = `stripe-${type}-${fromDateStr}-${toDateStr}.csv`;
        fs.writeFileSync(csvName, csv, 'utf-8');
    }

    const csv = itemsToCsv(csvItems);
    console.log(csv);
})();

function itemsToCsv(items) {
    const lines = [csvHeader];
    lines.push(...items.map(item => `${item.id},${item.date},${item.type},${item.amount},${item.description}`));
    return lines.join('\n');
}

function penceToMoney(pence) {
    return (pence/100).toFixed(2);
}

async function transactionToLineItems(transaction) {
    const items = [];
    let date = (new Date(transaction.created * 1000)).toISOString().split('T')[0];
    let description = `${transaction.description} [${transaction.id}]`;

    if (transaction.type === 'charge') {
        const customerName = [
            transaction.source?.customer?.name || transaction.source.billing_details.name,
            transaction.source?.customer?.email || transaction.source.billing_details.email,
        ].filter(Boolean).join(' / ');
        description = `${transaction.description} [${transaction.source.invoice || 'no_invoice'} - ${customerName}]`;
    } else if  (transaction.type === 'stripe_fee') {
        // Reverse fee values, so we can import them alongside transaction fees.
        transaction.amount = -(transaction.amount)
    } else if (transaction.type === 'payout') {
        date = (new Date(transaction.source.arrival_date * 1000)).toISOString().split('T')[0];
    }

    items.push({
        id: transaction.id,
        date,
        type: transaction.type,
        amount: penceToMoney(transaction.amount),
        description,
    });

    let feeCount = 1;
    for (const fee of (transaction.fee_details || [])) {
        items.push({
            id: `${transaction.id}_fee_${feeCount}`,
            date,
            type: fee.type,
            amount: penceToMoney(fee.amount),
            description: `${fee.description} - ${description}`
        });
        feeCount++
    }

    return items;
}