#!/usr/bin/env node
'use strict';
// Użycie: DATA_DIR=./data node scripts/import.js lista.tsv [--plus-one]
const fs = require('fs');
const path = require('path');
const { Store } = require('../lib/store');
const { bulkAdd } = require('../lib/guests');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Podaj plik: node scripts/import.js <plik.tsv> [--plus-one]');
  process.exit(1);
}
const store = new Store(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const res = bulkAdd(store, fs.readFileSync(file, 'utf8'), args.includes('--plus-one'), new Date().toISOString());
if (res.added.length) store.save();
console.log(`Dodano: ${res.added.length}, pominięto duplikaty: ${res.skipped.length}, błędy: ${res.errors.length}`);
for (const e of res.errors) console.log(`  wiersz ${e.line}: ${e.reason}`);
