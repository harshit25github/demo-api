import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisibleFlightContracts } from '../../public/chat-dashboard/flightContracts.js';

const contracts = [
  {
    airline: 'Air Canada',
    flight_number: 'AC 101',
    origin: 'JFK',
    destination: 'DEL',
    stops: 1,
    baggage: ['1', '0'],
    price: { amount: 820, currency: 'USD' },
    display: false,
  },
  {
    airline: 'Emirates',
    flight_number: 'EK 204',
    origin: 'JFK',
    destination: 'DEL',
    stops: 0,
    baggage: ['1'],
    price: { amount: 680, currency: 'USD' },
    display: true,
  },
  {
    airline: 'Qatar Airways',
    origin: 'JFK',
    destination: 'DEL',
    price: { amount: 790, currency: 'USD' },
  },
];

test('client view model keeps original option numbers and hides display=false contracts', () => {
  const visible = getVisibleFlightContracts({
    showFlight: true,
    searchResults: contracts,
  });

  assert.deepEqual(visible.map((contract) => contract.optionNumber), [2, 3]);
  assert.equal(visible[0].airline, 'Emirates');
  assert.equal(visible[0].price, '$680');
  assert.equal(visible[0].stops, 'Non-stop');
  assert.equal(visible[0].baggage, 'Carry-on');
});

test('client supports nested result containers and treats missing display as visible', () => {
  const visible = getVisibleFlightContracts({
    searchResults: {
      contracts,
      metadata: { page: 1 },
    },
  });

  assert.deepEqual(visible.map((contract) => contract.optionNumber), [2, 3]);
});

test('top-level showFlight=false suppresses all contract cards', () => {
  assert.deepEqual(
    getVisibleFlightContracts({ showFlight: false, searchResults: contracts }),
    [],
  );
});
