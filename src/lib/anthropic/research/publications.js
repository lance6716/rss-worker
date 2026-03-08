import { renderRss2 } from '../../../utils/util';

const BASE_URL = 'https://www.anthropic.com';
const RESEARCH_URL = `${BASE_URL}/research`;

const MONTHS = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	sept: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};

let normalizeText = (s) => (s || '').replace(/\s+/g, ' ').trim();

let parseDateToUTCString = (dateText) => {
	const m = normalizeText(dateText).match(/^([A-Za-z]{3,4})\s+(\d{1,2}),\s+(\d{4})$/);
	if (!m) {
		return undefined;
	}

	const mon = m[1].toLowerCase();
	const monthIndex = MONTHS[mon];
	if (monthIndex === undefined) {
		return undefined;
	}

	const day = Number(m[2]);
	const year = Number(m[3]);
	if (!Number.isFinite(day) || !Number.isFinite(year)) {
		return undefined;
	}

	return new Date(Date.UTC(year, monthIndex, day)).toUTCString();
};

let deal = async (ctx) => {
	const res = await fetch(RESEARCH_URL, {
		headers: {
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'en-US,en;q=0.9',
		},
	});

	if (!res.ok) {
		throw new Error(`failed to fetch anthropic research page: ${res.status} ${res.statusText}`);
	}

	let items = [];

	let publicationsUlDepth = 0;

	let current = null;
	let metaDivDepth = 0;
	let captureStack = [];
	let dateText = '';
	let categoryText = '';
	let titleText = '';

	const rewriter = new HTMLRewriter()
		.on('ul', {
			element(element) {
				const className = element.getAttribute('class') || '';

				const isPublicationList = className.includes('PublicationList') && className.includes('__list');

				if (publicationsUlDepth > 0) {
					publicationsUlDepth++;
					element.onEndTag(() => {
						publicationsUlDepth = Math.max(0, publicationsUlDepth - 1);
					});
					return;
				}
				if (isPublicationList) {
					publicationsUlDepth = 1;
					element.onEndTag(() => {
						publicationsUlDepth = Math.max(0, publicationsUlDepth - 1);
					});
				}
			},
		})
		.on('a', {
			element(element) {
				if (publicationsUlDepth === 0) {
					return;
				}

				const href = element.getAttribute('href') || '';
				if (!href.startsWith('/research/')) {
					return;
				}

				const link = new URL(href, BASE_URL).toString();
				current = { link };
				metaDivDepth = 0;
				captureStack = [];
				dateText = '';
				categoryText = '';
				titleText = '';

				element.onEndTag(() => {
					if (!current) {
						return;
					}

					const title = normalizeText(titleText);
					const category = normalizeText(categoryText);
					const rawDate = normalizeText(dateText);

					const pubDate = parseDateToUTCString(rawDate);

					const description = [category, rawDate].filter(Boolean).join(' - ') || title || current.link;

					items.push({
						title: title || current.link,
						link: current.link,
						guid: current.link,
						description,
						pubDate,
						category: category || undefined,
					});

					current = null;
					metaDivDepth = 0;
					captureStack = [];
					dateText = '';
					categoryText = '';
					titleText = '';
				});
			},
		})
		.on('div', {
			element(element) {
				if (!current) {
					return;
				}
				metaDivDepth++;

				element.onEndTag(() => {
					if (!current) {
						return;
					}
					metaDivDepth = Math.max(0, metaDivDepth - 1);
				});
			},
		})
		.on('time', {
			element(element) {
				if (!current) {
					return;
				}
				captureStack.push('date');

				element.onEndTag(() => {
					if (!current) {
						return;
					}
					captureStack.pop();
				});
			},
			text(text) {
				if (!current || captureStack[captureStack.length - 1] !== 'date') {
					return;
				}
				dateText += text.text;
			},
		})
		.on('span', {
			element(element) {
				if (!current) {
					return;
				}

				captureStack.push(metaDivDepth > 0 ? 'category' : 'title');
				element.onEndTag(() => {
					if (!current) {
						return;
					}
					captureStack.pop();
				});
			},
			text(text) {
				if (!current) {
					return;
				}

				const captureField = captureStack[captureStack.length - 1];
				if (captureField === 'category') {
					categoryText += text.text;
				} else if (captureField === 'title') {
					titleText += text.text;
				}
			},
		});

	await rewriter.transform(res).text();

	if (items.length === 0) {
		throw new Error('failed to parse anthropic publications list (no items found)');
	}

	let data = {
		title: 'Anthropic Research - Publications',
		link: RESEARCH_URL,
		description: 'Latest publications from Anthropic Research.',
		language: 'en-us',
		category: 'anthropic',
		items,
	};

	ctx.header('Content-Type', 'application/xml');
	return ctx.body(renderRss2(data));
};

let setup = (route) => {
	route.get('/anthropic/research/publications', deal);
};

export default { setup };
