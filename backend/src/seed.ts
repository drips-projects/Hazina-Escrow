import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';
import { Dataset, Transaction, writeStore, readStore, Store } from './common/storage';

const DATA_TYPES = [
  'whale-wallets',
  'trading-signals',
  'yield-data',
  'risk-scores',
  'nft-data',
  'sentiment',
];

/**
 * Generates a mock Stellar G-address using valid characters (A-Z, 2-7).
 */
const generateStellarAddress = () => {
  return 'G' + faker.string.fromCharacters('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 55);
};

const seed = async () => {
  const clean = process.argv.includes('--clean');
  console.log(
    `Starting seeding... ${clean ? '(Cleaning existing data)' : '(Appending to existing data)'}`,
  );

  const store: Store = clean ? { datasets: [], transactions: [], webhooks: [], payoutFailures: [] } : readStore();

  // Generate Datasets
  const numDatasets = 25;
  const newDatasets: Dataset[] = [];

  console.log(`Generating ${numDatasets} datasets...`);
  for (let i = 0; i < numDatasets; i++) {
    const id = `ds-${uuidv4()}`;
    const name =
      faker.company.name().split(',')[0] +
      ' ' +
      faker.helpers.arrayElement([
        'Index',
        'Signals',
        'Alpha',
        'Intelligence',
        'Analytics',
        'Insight',
        'Oracle',
      ]);

    const type = faker.helpers.arrayElement(DATA_TYPES);
    const queriesServed = faker.number.int({ min: 10, max: 5000 });
    const pricePerQuery = parseFloat(faker.finance.amount({ min: 0.1, max: 5, dec: 2 }));

    const dataset: Dataset = {
      id,
      name,
      description: faker.commerce.productDescription() + '. ' + faker.lorem.paragraph(),
      type,
      pricePerQuery,
      sellerWallet: generateStellarAddress(),
      data: {
        sample: faker.helpers.multiple(
          () => ({
            key: faker.string.uuid(),
            value: faker.number.float({ min: 0, max: 1000 }),
            timestamp: faker.date.recent().toISOString(),
          }),
          { count: 5 },
        ),
      },
      queriesServed,
      totalEarned: parseFloat((queriesServed * pricePerQuery).toFixed(2)),
      createdAt: faker.date.past({ years: 1 }).toISOString(),
    };
    newDatasets.push(dataset);
  }

  store.datasets.push(...newDatasets);

  // Generate Transactions
  const numTransactions = 150;
  console.log(`Generating ${numTransactions} transactions...`);
  for (let i = 0; i < numTransactions; i++) {
    const dataset = faker.helpers.arrayElement(store.datasets);
    const tx: Transaction = {
      id: `tx-${uuidv4()}`,
      datasetId: dataset.id,
      txHash: faker.string.hexadecimal({ length: 64, prefix: '' }).toLowerCase(),
      amount: dataset.pricePerQuery,
      sellerPaid: true,
      sellerAmount: parseFloat((dataset.pricePerQuery * 0.95).toFixed(7)),
      buyerQuery: faker.lorem.sentence().replace(/\.$/, '') + '?',
      aiSummary: faker.lorem.sentences(2),
      timestamp: faker.date.recent({ days: 90 }).toISOString(),
    };
    store.transactions.push(tx);
  }

  await writeStore(store);
  console.log(
    `Seeding complete! Total in store: ${store.datasets.length} datasets, ${store.transactions.length} transactions.`,
  );
};

seed().catch(console.error);
