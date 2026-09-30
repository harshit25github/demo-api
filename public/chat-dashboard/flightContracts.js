const RESULT_KEYS = ['flights', 'contracts', 'results', 'data'];

function resultArray(searchResults) {
  if (Array.isArray(searchResults)) return searchResults;
  if (!searchResults || typeof searchResults !== 'object') return [];
  for (const key of RESULT_KEYS) {
    if (Array.isArray(searchResults[key])) return searchResults[key];
  }
  return [];
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function priceLabel(price) {
  if (!price || !Number.isFinite(Number(price.amount))) return null;
  const amount = Number(price.amount);
  const currency = text(price.currency) || 'USD';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function stopsLabel(stops) {
  if (!Number.isInteger(stops)) return null;
  if (stops === 0) return 'Non-stop';
  return `${stops} ${stops === 1 ? 'stop' : 'stops'}`;
}

function baggageLabel(baggage) {
  if (!Array.isArray(baggage)) return null;
  const labels = [];
  if (baggage.includes('1')) labels.push('Carry-on');
  if (baggage.includes('0')) labels.push('Checked bag');
  if (baggage.includes('2')) labels.push('Personal item');
  return labels.length ? labels.join(' + ') : null;
}

export function getVisibleFlightContracts(flightContext = {}) {
  if (flightContext?.showFlight === false) return [];

  return resultArray(flightContext?.searchResults)
    .map((contract, index) => ({ contract, optionNumber: index + 1 }))
    .filter(({ contract }) => contract?.display !== false)
    .map(({ contract, optionNumber }) => ({
      optionNumber,
      airline: text(contract.airline || contract.airlineName) || 'Flight option',
      flightNumber: text(contract.flight_number || contract.flightNumber),
      origin: text(contract.origin || contract.departure_airport_code),
      destination: text(contract.destination || contract.arrival_airport_code),
      departureTime: text(contract.departure_time || contract.departureTime),
      arrivalTime: text(contract.arrival_time || contract.arrivalTime),
      duration: text(contract.duration),
      stops: stopsLabel(contract.stops),
      baggage: baggageLabel(contract.baggage),
      cabinClass: text(contract.cabin_class || contract.cabinClass),
      price: priceLabel(contract.price),
    }));
}

function appendText(parent, className, value) {
  if (!value) return null;
  const element = document.createElement('span');
  element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

export function renderFlightContracts(messageBody, flightContext) {
  messageBody?.querySelector('.flight-results')?.remove();
  const contracts = getVisibleFlightContracts(flightContext);
  if (!messageBody || contracts.length === 0) return null;

  const section = document.createElement('section');
  section.className = 'flight-results';
  section.setAttribute('aria-label', 'Current flight options');

  const heading = document.createElement('div');
  heading.className = 'flight-results-heading';
  heading.textContent = contracts.length === 1 ? 'Flight option' : 'Flight options';
  section.append(heading);

  for (const contract of contracts) {
    const row = document.createElement('article');
    row.className = 'flight-option';
    row.dataset.optionNumber = String(contract.optionNumber);

    const header = document.createElement('div');
    header.className = 'flight-option-header';
    const identity = document.createElement('div');
    identity.className = 'flight-option-identity';
    appendText(identity, 'flight-option-number', `Option ${contract.optionNumber}`);
    appendText(
      identity,
      'flight-option-airline',
      contract.flightNumber
        ? `${contract.airline} · ${contract.flightNumber}`
        : contract.airline,
    );
    header.append(identity);
    appendText(header, 'flight-option-price', contract.price);
    row.append(header);

    const route = document.createElement('div');
    route.className = 'flight-option-route';
    const departure = [contract.origin, contract.departureTime].filter(Boolean).join(' · ');
    const arrival = [contract.destination, contract.arrivalTime].filter(Boolean).join(' · ');
    appendText(route, 'flight-option-endpoint', departure);
    if (departure && arrival) appendText(route, 'flight-option-arrow', '→');
    appendText(route, 'flight-option-endpoint', arrival);
    if (route.children.length) row.append(route);

    const details = document.createElement('div');
    details.className = 'flight-option-details';
    for (const detail of [
      contract.duration,
      contract.stops,
      contract.baggage,
      contract.cabinClass,
    ]) {
      appendText(details, 'flight-option-detail', detail);
    }
    if (details.children.length) row.append(details);
    section.append(row);
  }

  const meta = messageBody.querySelector('.message-meta');
  messageBody.insertBefore(section, meta || null);
  return section;
}
