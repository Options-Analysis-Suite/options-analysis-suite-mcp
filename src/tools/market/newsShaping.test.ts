import { describe, expect, test } from 'bun:test';
import { shapeNewsResponse } from './newsShaping.js';

const APPLE_PROFILE = {
  company_name: 'Apple Inc.',
  description: 'Apple designs, manufactures and markets smartphones, personal computers, tablets, wearables, accessories, and related services.',
  sector: 'Technology',
  industry: 'Consumer Electronics',
};

const TESLA_PROFILE = {
  company_name: 'Tesla, Inc.',
  description: 'Tesla designs and manufactures electric vehicles, energy generation, and battery storage systems.',
  sector: 'Consumer Cyclical',
  industry: 'Auto Manufacturers',
};

const NVIDIA_PROFILE = {
  company_name: 'NVIDIA Corporation',
  description: 'NVIDIA designs graphics processors, AI accelerators, gaming hardware, and data center platforms.',
  sector: 'Technology',
  industry: 'Semiconductors',
};

const AMD_PROFILE = {
  company_name: 'Advanced Micro Devices, Inc.',
  description: 'AMD designs CPUs, GPUs, data center processors, and AI computing hardware.',
  sector: 'Technology',
  industry: 'Semiconductors',
};

const JPM_PROFILE = {
  company_name: 'JPMorgan Chase & Co.',
  description: 'JPMorgan Chase is a global financial services firm focused on banking, markets, and asset management.',
  sector: 'Financial Services',
  industry: 'Banks - Diversified',
};

const SPY_PROFILE = {
  company_name: 'SPDR S&P 500 ETF Trust',
  description: 'ETF tracking the S&P 500 index.',
  sector: 'ETF',
  industry: 'Index Fund',
  is_etf: true,
};

const XLY_PROFILE = {
  company_name: 'Consumer Discretionary Select Sector SPDR Fund',
  description: 'Sector ETF tracking consumer discretionary stocks.',
  sector: 'ETF',
  industry: 'Sector Fund',
  is_etf: true,
};

const XLK_PROFILE = {
  company_name: 'Technology Select Sector SPDR Fund',
  description: 'Sector ETF tracking technology stocks in the S&P 500.',
  sector: 'ETF',
  industry: 'Sector Fund',
  is_etf: true,
};

describe('shapeNewsResponse', () => {
  test('filters ambiguous-name false positives while keeping the strongest direct company headlines', () => {
    const payload = [
      {
        title: 'Apple introduces M5 MacBook Air with AI features',
        published_date: '2026-03-27T10:00:00Z',
        source: 'Reuters',
        url: 'https://example.com/apple-macbook',
        summary: 'Apple refreshed its laptop lineup and highlighted on-device AI features.',
      },
      {
        title: "Apple's Worldwide Developers Conference returns June 9",
        published_date: '2026-03-27T09:00:00Z',
        source: 'The Verge',
        url: 'https://example.com/apple-wwdc',
        summary: 'The company will preview new software and developer tooling.',
      },
      {
        title: 'Why Apple stock fell after fresh tariff worries',
        published_date: '2026-03-27T08:00:00Z',
        source: 'MarketWatch',
        url: 'https://example.com/apple-stock',
        summary: 'Investors weighed supplier risk and tariff exposure.',
      },
      {
        title: 'EU fines Apple over App Store rules',
        published_date: '2026-03-27T07:00:00Z',
        source: 'Bloomberg',
        url: 'https://example.com/apple-antitrust',
        summary: 'Regulators focused on app marketplace restrictions.',
      },
      {
        title: 'Golden Apple Awards recognize local teachers',
        published_date: '2026-03-27T06:00:00Z',
        source: 'Local News',
        url: 'https://example.com/golden-apple',
        summary: 'The annual education awards honored regional educators.',
      },
      {
        title: 'Apple Podcasts launches new creator program',
        published_date: '2026-03-27T05:00:00Z',
        source: 'Podcast Wire',
        url: 'https://example.com/apple-podcasts',
        summary: 'The podcast platform is adding new monetization options.',
      },
      {
        title: 'Apple iSports Group signs college NIL deal',
        published_date: '2026-03-27T04:00:00Z',
        source: 'Sports Biz',
        url: 'https://example.com/apple-isports',
        summary: 'A sports agency brand expanded its athlete roster.',
      },
    ];

    const result = shapeNewsResponse('AAPL', payload, APPLE_PROFILE) as Array<Record<string, unknown>>;

    expect(result.map((item) => item.title)).toEqual([
      'Apple introduces M5 MacBook Air with AI features',
      "Apple's Worldwide Developers Conference returns June 9",
    ]);
  });

  test('preserves key article fields and trims long summaries', () => {
    const longSummary = 'Apple services revenue keeps growing. '.repeat(12);
    const payload = {
      page: 1,
      results: [
        {
          title: 'Apple services revenue beats expectations',
          published_date: '2026-03-27T10:00:00Z',
          source: 'CNBC',
          url: 'https://example.com/apple-services',
          is_press_release: false,
          summary: longSummary,
        },
      ],
    };

    const result = shapeNewsResponse('AAPL', payload, APPLE_PROFILE) as {
      page: number;
      results: Array<Record<string, unknown>>;
    };

    expect(result.page).toBe(1);
    expect(result.results).toEqual([
      {
        title: 'Apple services revenue beats expectations',
        date: '2026-03-27T10:00:00Z',
        source: 'CNBC',
        url: 'https://example.com/apple-services',
        is_press_release: false,
        summary: `${longSummary.slice(0, 240)}...`,
      },
    ]);
  });

  test('omits filing-style ownership updates when higher-value catalyst news is available', () => {
    const payload = {
      results: [
        {
          title: 'Apple launches new enterprise AI tools for iPhone fleet management',
          published_date: '2026-03-27T10:00:00Z',
          source: 'Reuters',
          url: 'https://example.com/apple-enterprise',
          summary: 'Apple expanded enterprise services and device-management tooling.',
        },
        {
          title: 'Apple Inc. $AAPL is Everpar Advisors LLC’s 3rd Largest Position',
          published_date: '2026-03-27T09:00:00Z',
          source: 'defenseworld.net',
          url: 'https://example.com/everpar',
          summary: 'Everpar Advisors LLC grew its holdings in shares of Apple Inc. according to its most recent filing with the Securities and Exchange Commission.',
        },
        {
          title: 'CWA Asset Management Group LLC Increases Stake in Apple Inc. $AAPL',
          published_date: '2026-03-27T08:00:00Z',
          source: 'defenseworld.net',
          url: 'https://example.com/cwa',
          summary: 'The institutional investor increased its stake according to its most recent disclosure with the SEC.',
        },
      ],
    };

    const result = shapeNewsResponse('AAPL', payload, APPLE_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results).toEqual([
      {
        title: 'Apple launches new enterprise AI tools for iPhone fleet management',
        date: '2026-03-27T10:00:00Z',
        source: 'Reuters',
        url: 'https://example.com/apple-enterprise',
        is_press_release: undefined,
        summary: 'Apple expanded enterprise services and device-management tooling.',
      },
    ]);
    expect(result._results_meta?.filingStyleOmitted).toBe(2);
  });

  test('falls back to the most recent raw items when nothing clears the relevance threshold', () => {
    const payload = {
      results: Array.from({ length: 12 }, (_, index) => ({
        title: `Market roundup item ${index + 1}`,
        published_date: `2026-03-${String(27 - Math.min(index, 9)).padStart(2, '0')}T10:00:00Z`,
        url: `https://example.com/item-${index + 1}`,
      })),
    };

    const result = shapeNewsResponse('AAPL', payload, APPLE_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results).toHaveLength(10);
    expect(result.results[0]?.title).toBe('Market roundup item 1');
    expect(result.results[9]?.title).toBe('Market roundup item 10');
    expect(result._results_meta).toMatchObject({ showing: 10, total: 12, relevanceRanked: false });
  });

  test('keeps quarterly result headlines while filtering third-party name mentions', () => {
    const payload = [
      {
        title: 'Tesla Releases Fourth Quarter and Full Year 2025 Financial Results',
        published_date: '2026-03-27T10:00:00Z',
        source: 'Business Wire',
        url: 'https://example.com/tesla-results',
        summary: 'Tesla posted its latest investor update and financial results.',
      },
      {
        title: 'Tesla Fourth Quarter 2025 Production, Deliveries & Deployments',
        published_date: '2026-03-27T09:00:00Z',
        source: 'Business Wire',
        url: 'https://example.com/tesla-deliveries',
        summary: 'Vehicle deliveries and energy deployments were disclosed.',
      },
      {
        title: 'Spiritus Appoints Former Tesla Engineering Leader Dorian West to Support Scale-Up',
        published_date: '2026-03-27T08:00:00Z',
        source: 'Business Wire',
        url: 'https://example.com/former-tesla',
        summary: 'A climate startup hired a former Tesla executive.',
      },
    ];

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as Array<Record<string, unknown>>;

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Tesla Releases Fourth Quarter and Full Year 2025 Financial Results',
      'Tesla Fourth Quarter 2025 Production, Deliveries & Deployments',
    ]));
  });

  test('retains filing-style updates when they are the only relevant articles', () => {
    const payload = {
      results: [
        {
          title: 'Tesla, Inc. $TSLA Shares Bought by Diversified Trust Co.',
          published_date: '2026-03-27T10:00:00Z',
          source: 'defenseworld.net',
          url: 'https://example.com/diversified',
          summary: 'Diversified Trust Co. grew its stake in shares of Tesla, Inc. according to its most recent Form 13F filing with the SEC.',
        },
      ],
    };

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('Tesla, Inc. $TSLA Shares Bought by Diversified Trust Co.');
  });

  test('deduplicates repeated headlines from syndicated or mirrored URLs', () => {
    const payload = {
      results: [
        {
          title: 'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
          published_date: '2026-03-24T15:53:31Z',
          source: 'proactiveinvestors.com',
          url: 'https://www.proactiveinvestors.com/companies/news/1089431',
          summary: 'Tesla and SpaceX were reportedly planning a semiconductor plant.',
        },
        {
          title: 'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
          published_date: '2026-03-24T11:52:00Z',
          source: 'proactiveinvestors.com',
          url: 'https://www.proactiveinvestors.com/companies/news/1089431/tesla-spacex-terafab-plan-seen-as-key-to-easing-ai-bottleneck-1089431.html',
          summary: 'A mirrored version of the same article.',
        },
      ],
    };

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck');
  });

  test('omits low-signal market commentary when stronger company-specific news exists', () => {
    const payload = {
      results: [
        {
          title: 'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
          published_date: '2026-03-24T15:53:31Z',
          source: 'proactiveinvestors.com',
          url: 'https://example.com/terafab',
          summary: 'Tesla and SpaceX were reportedly planning a semiconductor plant.',
        },
        {
          title: 'Tesla Fourth Quarter 2025 Production, Deliveries & Deployments',
          published_date: '2026-03-24T11:52:00Z',
          source: 'Business Wire',
          url: 'https://example.com/deliveries',
          summary: 'Tesla disclosed production and delivery figures for the quarter.',
        },
        {
          title: 'BLBD vs. TSLA: Which Stock Should Value Investors Buy Now?',
          published_date: '2026-03-26T12:41:13Z',
          source: 'zacks.com',
          url: 'https://example.com/value-investors',
          summary: 'Investors interested in automotive names may compare Blue Bird and Tesla.',
        },
        {
          title: 'The Big 3: PLTR, TSLA, NVDA',
          published_date: '2026-03-24T13:00:42Z',
          source: 'youtube.com',
          url: 'https://example.com/big3',
          summary: 'A trading roundup video covering several large-cap names.',
        },
        {
          title: "Opinion: Tesla's valuation still looks stretched",
          published_date: '2026-03-24T10:00:00Z',
          source: '247wallst.com',
          url: 'https://example.com/opinion',
          summary: 'An opinion column argued Tesla shares remain expensive.',
        },
        {
          title: 'Why Tesla stock is outperforming the broader market today',
          published_date: '2026-03-24T11:19:34Z',
          source: 'invezz.com',
          url: 'https://example.com/outperforming',
          summary: 'Shares of Tesla rose while broader markets weakened.',
        },
        {
          title: 'Tesla Touts Lower EV Delivery Estimate. The Stock Is Falling.',
          published_date: '2026-03-26T15:10:15Z',
          source: 'investors.com',
          url: 'https://example.com/stock-falling',
          summary: 'Tesla stock fell after a lower analyst delivery estimate.',
        },
      ],
    };

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results).toHaveLength(2);
    expect(result.results.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
      'Tesla Fourth Quarter 2025 Production, Deliveries & Deployments',
    ]));
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('treats normalized low-signal source domains as commentary even without title phrases', () => {
    const payload = {
      results: [
        {
          title: 'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
          published_date: '2026-03-24T15:53:31Z',
          source: 'proactiveinvestors.com',
          url: 'https://example.com/terafab',
          summary: 'Tesla and SpaceX were reportedly planning a semiconductor plant.',
        },
        {
          title: 'Tesla Fourth Quarter 2025 Production, Deliveries & Deployments',
          published_date: '2026-03-24T11:52:00Z',
          source: 'Business Wire',
          url: 'https://example.com/deliveries',
          summary: 'Tesla disclosed production and delivery figures for the quarter.',
        },
        {
          title: "This Could Cut Tesla's Stock Price By 70%",
          published_date: '2026-03-26T10:00:00Z',
          source: '247wallst.com',
          url: 'https://example.com/247wallst-tesla',
          summary: 'A commentary piece argued Tesla shares could decline sharply.',
        },
      ],
    };

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results).toHaveLength(2);
    expect(result.results.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
      'Tesla Fourth Quarter 2025 Production, Deliveries & Deployments',
    ]));
    expect(result.results.map((item) => item.title)).not.toContain("This Could Cut Tesla's Stock Price By 70%");
    expect(result._results_meta?.lowSignalOmitted).toBe(1);
  });

  test('retains low-signal commentary when it is the only relevant news available', () => {
    const payload = {
      results: [
        {
          title: 'The Big 3: PLTR, TSLA, NVDA',
          published_date: '2026-03-24T13:00:42Z',
          source: 'youtube.com',
          url: 'https://example.com/big3',
          summary: 'A trading roundup video covering several large-cap names.',
        },
      ],
    };

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('The Big 3: PLTR, TSLA, NVDA');
  });

  test('omits opinion-style analyst blog posts when stronger company-specific news is available', () => {
    const payload = {
      results: [
        {
          title: 'Apple iPhone loyalty strengthens, supporting services growth outlook',
          published_date: '2026-03-26T15:18:01Z',
          source: 'proactiveinvestors.com',
          url: 'https://example.com/apple-loyalty',
          summary: 'Apple iPhone ecosystem loyalty improved and services remained a profitability driver.',
        },
        {
          title: "Apple's 50th Anniversary: A Solid Hold For Wealth Preservation",
          published_date: '2026-03-27T07:23:49Z',
          source: 'seekingalpha.com',
          url: 'https://seekingalpha.com/article/apple-solid-hold',
          summary: 'Apple remains a mature tech giant suited for wealth preservation.',
        },
        {
          title: "Strong Streaming & Game Content Aids Apple's Services: What's Ahead?",
          published_date: '2026-03-27T12:32:19Z',
          source: 'zacks.com',
          url: 'https://www.zacks.com/stock/news/2891062/foo?cid=CS-STOCKNEWSAPI-FT-analyst_blog|quick_take-2891062',
          summary: 'AAPL services growth continues. What’s next for AAPL stock?',
        },
        {
          title: "Apple's Worldwide Developers Conference returns the week of June 8",
          published_date: '2026-03-23T10:00:00Z',
          source: 'Press Release',
          url: 'https://example.com/apple-wwdc',
          is_press_release: true,
          summary: 'Apple announced the timing of WWDC.',
        },
      ],
    };

    const result = shapeNewsResponse('AAPL', payload, APPLE_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Apple iPhone loyalty strengthens, supporting services growth outlook',
      "Apple's Worldwide Developers Conference returns the week of June 8",
    ]);
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('omits legal press-release noise when stronger Tesla catalyst news exists', () => {
    const payload = {
      results: [
        {
          title: 'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
          published_date: '2026-03-24T15:53:31Z',
          source: 'proactiveinvestors.com',
          url: 'https://example.com/terafab',
          summary: 'Tesla and SpaceX were reportedly planning a semiconductor plant.',
        },
        {
          title: 'Tesla Fourth Quarter 2025 Production, Deliveries & Deployments',
          published_date: '2026-01-02T10:00:00Z',
          source: 'Press Release',
          url: 'https://example.com/tesla-deliveries',
          is_press_release: true,
          summary: 'Tesla disclosed quarterly production and delivery figures.',
        },
        {
          title: 'Family Sues Tesla After Autopilot Fails to Detect Motorcycle, Killing 28-Year-Old Rider says Law Firm Osborn Machler',
          published_date: '2026-01-09T10:00:00Z',
          source: 'Press Release',
          url: 'https://example.com/tesla-lawsuit',
          is_press_release: true,
          summary: 'A law firm announced a wrongful death lawsuit against Tesla.',
        },
        {
          title: "The Tesla Robotaxi Story Is A Myth: Why I'm Maintaining My Strong Sell Into Q1 Earnings",
          published_date: '2026-03-27T08:45:00Z',
          source: 'seekingalpha.com',
          url: 'https://seekingalpha.com/article/tesla-strong-sell',
          summary: 'An opinion column maintained a strong sell rating ahead of earnings.',
        },
      ],
    };

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck');
    expect(result._results_meta?.stalePressReleaseOmitted).toBeDefined();
  });

  test('omits third-party press releases that only mention the company indirectly when direct company news exists', () => {
    const payload = {
      results: [
        {
          title: 'Apple iPhone loyalty strengthens, supporting services growth outlook',
          published_date: '2026-03-26T15:18:01Z',
          source: 'proactiveinvestors.com',
          url: 'https://example.com/apple-loyalty',
          summary: 'Apple iPhone ecosystem loyalty improved and services remained a profitability driver.',
        },
        {
          title: "Apple's Worldwide Developers Conference returns the week of June 8",
          published_date: '2026-03-23T10:00:00Z',
          source: 'Press Release',
          url: 'https://example.com/apple-wwdc',
          is_press_release: true,
          summary: 'Apple announced the timing of WWDC.',
        },
        {
          title: "Other World Computing (OWC) Announces Storage and Connectivity Solutions for Apple's New MacBook Neo",
          published_date: '2026-03-05T10:00:00Z',
          source: 'Press Release',
          url: 'https://example.com/owc-macbook',
          is_press_release: true,
          summary: 'A third-party accessory maker announced hardware for a new Apple laptop.',
        },
      ],
    };

    const result = shapeNewsResponse('AAPL', payload, APPLE_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Apple iPhone loyalty strengthens, supporting services growth outlook',
      "Apple's Worldwide Developers Conference returns the week of June 8",
    ]);
    expect(result.results.map((item) => item.title)).not.toContain(
      "Other World Computing (OWC) Announces Storage and Connectivity Solutions for Apple's New MacBook Neo",
    );
    expect(result._results_meta).toMatchObject({ showing: 2, total: 3, relevanceRanked: true });
  });

  test('omits stock-sentiment commentary when stronger direct Tesla news exists', () => {
    const payload = {
      results: [
        {
          title: 'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
          published_date: '2026-03-24T15:53:31Z',
          source: 'proactiveinvestors.com',
          url: 'https://example.com/terafab',
          summary: 'Tesla and SpaceX were reportedly planning a semiconductor plant.',
        },
        {
          title: 'Tesla Fourth Quarter 2025 Production, Deliveries & Deployments',
          published_date: '2026-01-02T10:00:00Z',
          source: 'Press Release',
          url: 'https://example.com/tesla-deliveries',
          is_press_release: true,
          summary: 'Tesla disclosed quarterly production and delivery figures.',
        },
        {
          title: 'Tesla Stock Falls. Wedbush Predicts Tesla--SpaceX Mega Merger by 2027',
          published_date: '2026-03-27T11:33:00Z',
          source: 'gurufocus.com',
          url: 'https://example.com/tesla-stock-falls',
          summary: 'Tesla shares fell even as Wedbush reiterated an outperform rating and price target.',
        },
        {
          title: 'Tesla stock struggles as delivery fears and Musk bets test investor faith',
          published_date: '2026-03-27T13:59:57Z',
          source: 'invezz.com',
          url: 'https://example.com/tesla-stock-struggles',
          summary: 'Shares of Tesla remained under pressure as investors weighed softer delivery expectations.',
        },
        {
          title: "HSBC Thinks Tesla Stock Could Fall 65%. Here's Why.",
          published_date: '2026-03-27T17:48:00Z',
          source: 'fool.com',
          url: 'https://example.com/tesla-could-fall',
          summary: 'Bears think Tesla shares are significantly overvalued.',
        },
        {
          title: 'Honda, Sony Scrap Afeela EV Plans Amid ¥2.5 Trillion Cost Warning',
          published_date: '2026-03-25T11:22:00Z',
          source: 'gurufocus.com',
          url: 'https://example.com/afeela',
          summary: 'The change could benefit Tesla by weakening a would-be EV rival.',
        },
        {
          title: "These 3 'Mag 7' Stocks To Likely Lead The Rest",
          published_date: '2026-03-27T14:54:12Z',
          source: 'seekingalpha.com',
          url: 'https://example.com/mag7',
          summary: 'Tesla is one of several megacap names discussed in a basket commentary piece.',
        },
        {
          title: "Why Tesla Investors Should Care About SpaceX's IPO",
          published_date: '2026-03-27T14:25:43Z',
          source: 'investopedia.com',
          url: 'https://example.com/spacex-ipo',
          summary: 'Tesla investors may want to track the coming SpaceX IPO for cross-holdings and sentiment reasons.',
        },
      ],
    };

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
    ]);
    expect(result.results.map((item) => item.title)).not.toEqual(expect.arrayContaining([
      'Honda, Sony Scrap Afeela EV Plans Amid ¥2.5 Trillion Cost Warning',
      "These 3 'Mag 7' Stocks To Likely Lead The Rest",
      "Why Tesla Investors Should Care About SpaceX's IPO",
    ]));
    expect(result._results_meta?.stalePressReleaseOmitted).toBeDefined();
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('demotes stale company press releases below fresher direct company news', () => {
    const payload = {
      results: [
        {
          title: 'Meta data-center deal revised to lower customer costs',
          published_date: '2026-03-27T10:30:03Z',
          source: 'Reuters',
          url: 'https://example.com/meta-reuters',
          summary: 'Entergy said a revised Meta data-center deal would deliver higher customer savings.',
        },
        {
          title: 'Meta stock just paid dividends; here’s how much investors received',
          published_date: '2026-03-27T06:18:33Z',
          source: 'finbold.com',
          url: 'https://example.com/meta-dividend',
          summary: 'Meta paid its latest dividend on March 26.',
        },
        {
          title: 'Meta Announces Quarterly Cash Dividend',
          published_date: '2026-02-12T10:00:00Z',
          source: 'Press Release',
          url: 'https://example.com/meta-press-dividend',
          is_press_release: true,
          summary: 'Meta declared a quarterly cash dividend.',
        },
        {
          title: 'Meta Reports Fourth Quarter and Full Year 2025 Results',
          published_date: '2026-01-28T10:00:00Z',
          source: 'Press Release',
          url: 'https://example.com/meta-results',
          is_press_release: true,
          summary: 'Meta reported fourth quarter and full year results.',
        },
      ],
    };

    const result = shapeNewsResponse('META', payload, {
      company_name: 'Meta Platforms, Inc.',
      description: 'Meta builds social media and advertising platforms and invests in AI infrastructure.',
      sector: 'Communication Services',
      industry: 'Internet Content & Information',
    }) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Meta data-center deal revised to lower customer costs',
    ]);
    expect(result._results_meta?.stalePressReleaseOmitted).toBeDefined();
  });

  test('infers BusinessWire press-release dates for stale-ranking and returned date fields', () => {
    const payload = {
      results: [
        {
          title: 'Apple Plans to Allow Siri to Access Multiple AI Assistants',
          published_date: '2026-03-26T15:50:09Z',
          source: 'pymnts.com',
          url: 'https://example.com/apple-siri',
          summary: 'Apple plans to let Siri route to additional AI assistants.',
        },
        {
          title: 'Apple introduces iPhone 17e',
          source: 'Press Release',
          url: 'https://www.businesswire.com/news/home/20260302227994/en/Apple-introduces-iPhone-17e/',
          is_press_release: true,
          summary: 'CUPERTINO, Calif.--(BUSINESS WIRE)--Apple today announced iPhone 17e.',
        },
      ],
    };

    const result = shapeNewsResponse('AAPL', payload, APPLE_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('Apple Plans to Allow Siri to Access Multiple AI Assistants');
    expect(result._results_meta?.stalePressReleaseOmitted).toBeDefined();
  });

  test('prefers direct Apple operating news over roundup and indirect mention noise', () => {
    const payload = {
      results: [
        {
          title: 'Apple hires ex-Google executive to head AI marketing amid push to improve Siri',
          published_date: '2026-03-27T13:42:19Z',
          source: 'reuters.com',
          url: 'https://example.com/apple-reuters-ai',
          summary: 'Apple hired a former Google executive to lead AI marketing.',
        },
        {
          title: 'Apple expands American manufacturing program with four new partners',
          published_date: '2026-03-26T09:00:01Z',
          source: 'cnbc.com',
          url: 'https://example.com/apple-cnbc-manufacturing',
          summary: 'Apple expanded its U.S. manufacturing program with new partners.',
        },
        {
          title: "Ardagh Metal Packaging, Apple And Netflix On CNBC's 'Final Trades'",
          published_date: '2026-03-26T07:11:14Z',
          source: 'feeds.benzinga.com',
          url: 'https://example.com/final-trades',
          summary: 'CNBC final trades mentioned Apple among several names.',
        },
        {
          title: "Warren Buffett's Berkshire Faces The Dreaded Death Cross—Is Too Much Apple The Problem?",
          published_date: '2026-03-26T11:26:09Z',
          source: 'benzinga.com',
          url: 'https://example.com/death-cross',
          summary: 'A Berkshire-focused technical article mentioned Apple exposure.',
        },
        {
          title: 'Nextech3D.ai Expands Blockchain Ticketing Payments to Apple Pay and Google Pay, Advancing Platform Readiness for Adoption',
          published_date: '2026-03-26T07:30:00Z',
          source: 'accessnewswire.com',
          url: 'https://example.com/apple-pay-third-party',
          summary: 'A third-party company announced broader wallet support including Apple Pay.',
        },
      ],
    };

    const result = shapeNewsResponse('AAPL', payload, APPLE_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Apple hires ex-Google executive to head AI marketing amid push to improve Siri',
      'Apple expands American manufacturing program with four new partners',
    ]);
    expect(result._results_meta).toMatchObject({ showing: 2, total: 5, relevanceRanked: true });
  });

  test('collapses near-duplicate Apple event coverage into the strongest source per story', () => {
    const payload = {
      results: [
        {
          title: 'Apple hires ex-Google executive to head AI marketing amid push to improve Siri',
          published_date: '2026-03-27T13:42:19Z',
          source: 'reuters.com',
          url: 'https://example.com/apple-hire-reuters',
          summary: 'Apple hired a former Google executive to lead AI marketing as it works to improve Siri.',
        },
        {
          title: 'Apple plans to open Siri to rival AI services, Bloomberg News reports',
          published_date: '2026-03-26T14:30:39Z',
          source: 'reuters.com',
          url: 'https://example.com/apple-siri-reuters',
          summary: 'Apple plans to open its Siri voice assistant to rival artificial intelligence services beyond its current partnership with ChatGPT.',
        },
        {
          title: 'Apple Plans to Allow Siri to Access Multiple AI Assistants',
          published_date: '2026-03-26T15:50:09Z',
          source: 'pymnts.com',
          url: 'https://example.com/apple-siri-pymnts',
          summary: "Apple plans to allow other companies' artificial intelligence assistants to be accessed from within its Siri voice assistant.",
        },
        {
          title: 'Apple expands American manufacturing program with four new partners',
          published_date: '2026-03-26T09:00:01Z',
          source: 'cnbc.com',
          url: 'https://example.com/apple-manufacturing-cnbc',
          summary: 'Apple will spend $400 million through 2030 with Bosch, Cirrus Logic, TDK and Qnity Electronics through its American manufacturing program.',
        },
        {
          title: 'Apple adds Bosch, Cirrus Logic, others to US manufacturing program, to invest $400 million',
          published_date: '2026-03-26T09:02:24Z',
          source: 'reuters.com',
          url: 'https://example.com/apple-manufacturing-reuters',
          summary: 'Apple said it was adding Bosch, Cirrus Logic, TDK and Qnity Electronics to its American Manufacturing Program with plans to invest $400 million through 2030.',
        },
        {
          title: 'Apple Expands Its US Manufacturing Program With Bosch, Cirrus Logic and Others',
          published_date: '2026-03-26T16:44:50Z',
          source: 'cnet.com',
          url: 'https://example.com/apple-manufacturing-cnet',
          summary: 'The company expanded its US manufacturing program with Bosch, Cirrus Logic and other new partners.',
        },
        {
          title: "Apple's Worldwide Developers Conference returns the week of June 8",
          published_date: '2026-03-23T00:00:00Z',
          source: 'Press Release',
          url: 'https://example.com/apple-wwdc',
          is_press_release: true,
          summary: 'Apple announced the timing of WWDC.',
        },
      ],
    };

    const result = shapeNewsResponse('AAPL', payload, APPLE_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Apple plans to open Siri to rival AI services, Bloomberg News reports',
      'Apple hires ex-Google executive to head AI marketing amid push to improve Siri',
      'Apple expands American manufacturing program with four new partners',
      "Apple's Worldwide Developers Conference returns the week of June 8",
    ]);
    expect(result._results_meta?.nearDuplicatesCollapsed).toBe(3);
  });

  test('prefers direct Meta reporting over stock-commentary and options-flow recaps', () => {
    const payload = {
      results: [
        {
          title: 'Utility Entergy says revised Meta data-center deal to deliver higher customer savings',
          published_date: '2026-03-27T10:30:03Z',
          source: 'reuters.com',
          url: 'https://example.com/meta-reuters',
          summary: 'A revised agreement will lower customer costs for Meta’s planned data center.',
        },
        {
          title: 'Meta Platforms: Lean Into The Fear As P/Cash Drops To 10x',
          published_date: '2026-03-27T12:43:54Z',
          source: 'seekingalpha.com',
          url: 'https://example.com/meta-opinion',
          summary: 'An opinion column argued Meta looks cheap after its selloff.',
        },
        {
          title: 'Investors Buy Large Volume of Call Options on Meta Platforms (NASDAQ:META)',
          published_date: '2026-03-27T05:04:47Z',
          source: 'defenseworld.net',
          url: 'https://example.com/meta-call-options',
          summary: 'A short article noted elevated call-option volume in Meta.',
        },
        {
          title: 'Meta stock just paid dividends; here’s how much investors received',
          published_date: '2026-03-27T06:18:33Z',
          source: 'finbold.com',
          url: 'https://example.com/meta-dividend',
          summary: 'A short recap noted the cash amount Meta just paid.',
        },
        {
          title: 'Meta Stock Is Falling Again. What Can Stop the Rot.',
          published_date: '2026-03-27T07:33:00Z',
          source: 'barrons.com',
          url: 'https://example.com/meta-rot',
          summary: 'A commentary article discussed Meta’s selloff.',
        },
        {
          title: 'Meta stock selloff continues, but a bigger risk looms',
          published_date: '2026-03-27T12:38:47Z',
          source: 'invezz.com',
          url: 'https://example.com/meta-selloff',
          summary: 'Shares of Meta remained under pressure as investors weighed legal setbacks.',
        },
        {
          title: 'Tech stocks suffer worst week in nearly a year, driven down by war worries, Meta legal woes',
          published_date: '2026-03-27T16:24:53Z',
          source: 'cnbc.com',
          url: 'https://example.com/meta-tech-stocks',
          summary: 'A broader tech-market wrap discussed Meta among several names.',
        },
      ],
    };

    const result = shapeNewsResponse('META', payload, {
      company_name: 'Meta Platforms, Inc.',
      description: 'Meta builds social media and advertising platforms and invests in AI infrastructure.',
      sector: 'Communication Services',
      industry: 'Internet Content & Information',
    }) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Utility Entergy says revised Meta data-center deal to deliver higher customer savings',
    ]);
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('demotes Tesla competitor and low-signal commentary when stronger direct Tesla news exists', () => {
    const payload = {
      results: [
        {
          title: 'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
          published_date: '2026-03-24T15:53:31Z',
          source: 'proactiveinvestors.com',
          url: 'https://example.com/terafab',
          summary: 'Tesla and SpaceX were reportedly planning a semiconductor plant.',
        },
        {
          title: 'Elon Musk Drops Fresh Clues On Possible 3-Row Vehicle From Tesla',
          published_date: '2026-03-27T00:35:22Z',
          source: 'feeds.benzinga.com',
          url: 'https://example.com/three-row',
          summary: 'Tesla’s CEO dropped new hints about a possible vehicle with three rows.',
        },
        {
          title: 'Amazon Is Buying Its Way Into Robots — Tesla Is Building Them From Scratch',
          published_date: '2026-03-25T10:44:30Z',
          source: 'benzinga.com',
          url: 'https://example.com/robots',
          summary: 'A comparison piece contrasted Amazon’s acquisition strategy with Tesla’s robotics push.',
        },
        {
          title: 'Tesla Beware: BYD Just Played The James Bond Card In Europe',
          published_date: '2026-03-26T18:27:28Z',
          source: 'benzinga.com',
          url: 'https://example.com/byd',
          summary: 'A BYD-focused piece framed Tesla as the comparison point.',
        },
        {
          title: 'Meta Targets $9 Trillion Value With AI-Driven Exec Pay Plan That Outstrips Musk and Tesla',
          published_date: '2026-03-25T04:58:00Z',
          source: 'barrons.com',
          url: 'https://example.com/meta-musk',
          summary: 'A Meta story referenced Tesla and Musk only as a comparison point.',
        },
      ],
    };

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
    ]);
    expect(result._results_meta).toMatchObject({ showing: 1, total: 5, relevanceRanked: true });
  });

  test('infers PRNewswire-style dateline dates when explicit publish timestamps are missing', () => {
    const payload = {
      results: [
        {
          title: 'Meta Announces Quarterly Cash Dividend',
          source: 'Press Release',
          url: 'https://www.prnewswire.com/news-releases/meta-announces-quarterly-cash-dividend-302686892.html',
          is_press_release: true,
          summary: 'MENLO PARK, Calif., Feb. 12, 2026 /PRNewswire/ -- Meta Platforms, Inc. declared a quarterly cash dividend.',
        },
      ],
    };

    const result = shapeNewsResponse('META', payload, {
      company_name: 'Meta Platforms, Inc.',
      description: 'Meta builds social media and advertising platforms and invests in AI infrastructure.',
      sector: 'Communication Services',
      industry: 'Internet Content & Information',
    }) as { results: Array<Record<string, unknown>> };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('Meta Announces Quarterly Cash Dividend');
    expect(result.results[0]?.date).toBe('2026-02-12T00:00:00.000Z');
  });

  test('filters ETF ticker collisions while keeping genuine ETF coverage', () => {
    const payload = {
      results: [
        {
          title: 'Should You Invest in the State Street Consumer Discretionary Select Sector SPDR ETF (XLY)?',
          published_date: '2026-02-09T07:21:16Z',
          source: 'zacks.com',
          url: 'https://example.com/xly-etf',
          summary: 'The State Street Consumer Discretionary Select Sector SPDR ETF is a passively managed exchange traded fund.',
        },
        {
          title: 'Auxly Cannabis Group Inc. (XLY:CA) Q4 2025 Earnings Call Transcript',
          published_date: '2026-03-27T12:15:59Z',
          source: 'seekingalpha.com',
          url: 'https://example.com/auxly',
          summary: 'Auxly Cannabis Group held its earnings call.',
        },
      ],
    };

    const result = shapeNewsResponse('XLY', payload, XLY_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('Should You Invest in the State Street Consumer Discretionary Select Sector SPDR ETF (XLY)?');
    expect(result._results_meta).toMatchObject({ showing: 1, total: 2, relevanceRanked: true });
  });

  test('keeps market ETF headlines that reference the benchmark and ETF symbol directly', () => {
    const payload = {
      results: [
        {
          title: 'S&P 500 Is Sitting 6% Below Its January Record. Is Now the Time to Add to Your SPY Position?',
          published_date: '2026-03-24T06:50:00Z',
          source: 'fool.com',
          url: 'https://example.com/spy-position',
          summary: 'The S&P 500 pullback may be a buying opportunity for SPY holders.',
        },
        {
          title: 'Spy School Opens New Training Program',
          published_date: '2026-03-24T06:00:00Z',
          source: 'Local News',
          url: 'https://example.com/spy-school',
          summary: 'A local academy launched an intelligence-themed program.',
        },
      ],
    };

    const result = shapeNewsResponse('SPY', payload, SPY_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('S&P 500 Is Sitting 6% Below Its January Record. Is Now the Time to Add to Your SPY Position?');
    expect(result._results_meta).toMatchObject({ showing: 1, total: 2, relevanceRanked: true });
  });

  test('filters live META stock-commentary noise when direct company reporting exists', () => {
    const payload = {
      results: [
        {
          title: 'Meta data-center deal revised to lower customer costs',
          published_date: '2026-03-27T10:30:03Z',
          source: 'reuters.com',
          url: 'https://example.com/meta-data-center',
          summary: 'Entergy revised a Meta data-center agreement to deliver higher customer savings.',
        },
        {
          title: "1 Reason Meta's AI Spending Spree Won't Slow Down in 2026",
          published_date: '2026-03-27T12:00:00Z',
          source: 'fool.com',
          url: 'https://example.com/meta-spending-spree',
          summary: 'A commentary piece argued Meta will keep spending heavily on AI in 2026.',
        },
        {
          title: 'Verdicts against Meta, YouTube could be a turning point, expert says',
          published_date: '2026-03-27T11:00:00Z',
          source: 'techxplore.com',
          url: 'https://example.com/meta-expert-says',
          summary: 'An expert commented on legal verdicts involving Meta and YouTube.',
        },
      ],
    };

    const result = shapeNewsResponse('META', payload, {
      company_name: 'Meta Platforms, Inc.',
      description: 'Meta builds social media and advertising platforms and invests in AI infrastructure.',
      sector: 'Communication Services',
      industry: 'Internet Content & Information',
    }) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Meta data-center deal revised to lower customer costs',
    ]);
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('filters live Tesla commentary and indirect comparison headlines when direct Tesla news exists', () => {
    const payload = {
      results: [
        {
          title: 'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
          published_date: '2026-03-24T15:53:31Z',
          source: 'proactiveinvestors.com',
          url: 'https://example.com/terafab',
          summary: 'Tesla and SpaceX were reportedly planning a semiconductor plant.',
        },
        {
          title: 'Elon Musk Drops Fresh Clues On Possible 3-Row Vehicle From Tesla',
          published_date: '2026-03-27T00:35:22Z',
          source: 'feeds.benzinga.com',
          url: 'https://example.com/three-row',
          summary: 'Tesla’s CEO dropped new hints about a possible vehicle with three rows.',
        },
        {
          title: 'Judge declines to recuse herself in shareholder lawsuit against Tesla',
          published_date: '2026-03-27T13:00:00Z',
          source: 'businessinsider.com',
          url: 'https://example.com/tesla-recusal',
          summary: 'A judge declined to step aside in a shareholder lawsuit involving Tesla.',
        },
        {
          title: "Why Tesla isn't getting a boost from the broader market rally",
          published_date: '2026-03-27T14:00:00Z',
          source: 'marketwatch.com',
          url: 'https://example.com/tesla-market-rally',
          summary: 'A stock-performance commentary piece discussed why Tesla lagged a broader rally.',
        },
        {
          title: 'Tesla Beware: BYD Just Played The James Bond Card In Europe',
          published_date: '2026-03-26T18:27:28Z',
          source: 'benzinga.com',
          url: 'https://example.com/byd',
          summary: 'A BYD-focused piece framed Tesla as the comparison point.',
        },
      ],
    };

    const result = shapeNewsResponse('TSLA', payload, TESLA_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Tesla, SpaceX Terafab plan seen as key to easing AI bottleneck',
    ]);
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('filters other-ticker ETF headlines and listicle noise when stronger SPY benchmark news exists', () => {
    const payload = {
      results: [
        {
          title: 'S&P 500 target rises as strategists update year-end forecasts; SPY holders watch benchmark',
          published_date: '2026-03-27T12:00:00Z',
          source: 'reuters.com',
          url: 'https://example.com/spy-benchmark',
          summary: 'Strategists raised year-end S&P 500 targets, a key benchmark for SPY.',
        },
        {
          title: 'QDPL: The Smart Way to Generate Regular Income',
          published_date: '2026-03-27T09:00:00Z',
          source: 'etftrends.com',
          url: 'https://example.com/qdpl-income',
          summary: 'A separate ETF income article referenced portfolio income.',
        },
        {
          title: 'Best Performing Stocks Today',
          published_date: '2026-03-27T08:00:00Z',
          source: 'marketwatch.com',
          url: 'https://example.com/best-performing-stocks',
          summary: 'A market listicle mentioned the S&P 500 among broad market benchmarks.',
        },
      ],
    };

    const result = shapeNewsResponse('SPY', payload, SPY_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'S&P 500 target rises as strategists update year-end forecasts; SPY holders watch benchmark',
    ]);
    expect(result._results_meta).toMatchObject({ showing: 1, total: 3, relevanceRanked: true });
  });

  test('requires strong ETF title references when direct XLK fund news exists', () => {
    const payload = {
      results: [
        {
          title: 'XLK Offers Focused Access to Megacap Technology Leaders',
          published_date: '2026-03-27T10:00:00Z',
          source: 'etf.com',
          url: 'https://example.com/xlk-direct',
          summary: 'XLK gives investors direct technology-sector exposure through a concentrated megacap basket.',
        },
        {
          title: 'ETF Prime: The Tactical Roadmap for Sector Investing',
          published_date: '2026-03-27T09:00:00Z',
          source: 'etftrends.com',
          url: 'https://example.com/etf-prime',
          summary: 'A generic segment discussed sector investing themes across multiple funds.',
        },
        {
          title: 'Mixing Sector ETFs for an Equal Sector Strategy',
          published_date: '2026-03-27T08:00:00Z',
          source: 'etftrends.com',
          url: 'https://example.com/equal-sector',
          summary: 'A broad allocation article compared multiple sector ETFs.',
        },
      ],
    };

    const result = shapeNewsResponse('XLK', payload, XLK_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'XLK Offers Focused Access to Megacap Technology Leaders',
    ]);
    expect(result._results_meta).toMatchObject({ showing: 1, total: 3, relevanceRanked: true });
  });

  test('filters legal-alert noise and generic analyst churn for JPM when more substantive bank news exists', () => {
    const payload = {
      results: [
        {
          title: "JPMORGAN CHASE & CO. INVESTOR ALERT: Scott+Scott Attorneys at Law LLP Investigates JPMorgan Chase & Co.'s Directors and Officers for Breach of Fiduciary Duties – JPM",
          published_date: '2026-03-26T16:00:00Z',
          source: 'businesswire.com',
          url: 'https://example.com/jpm-investor-alert',
          summary: 'A law firm announced an investigation into JPMorgan directors and officers.',
        },
        {
          title: 'Why JPMorgan Chase & Co. (JPM) is a Top Stock for the Long-Term',
          published_date: '2026-03-24T10:31:19Z',
          source: 'zacks.com',
          url: 'https://example.com/jpm-top-stock',
          summary: 'A generic long-term stock ranking piece on JPMorgan.',
        },
        {
          title: 'Large Banks Score Major Regulatory Win That Could Free Up Tens of Billions in Capital. Should You Buy JPMorgan Chase Stock?',
          published_date: '2026-03-24T14:05:00Z',
          source: 'fool.com',
          url: 'https://example.com/jpm-regulatory-win',
          summary: 'Regulators released a proposal updating capital rules for large banks.',
        },
      ],
    };

    const result = shapeNewsResponse('JPM', payload, JPM_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Large Banks Score Major Regulatory Win That Could Free Up Tens of Billions in Capital. Should You Buy JPMorgan Chase Stock?',
    ]);
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('omits insider-sale and valuation chatter for Nvidia when stronger direct news exists', () => {
    const payload = {
      results: [
        {
          title: 'Mark Stevens Sells 221,682 Shares of NVIDIA (NASDAQ:NVDA) Stock',
          published_date: '2026-03-27T04:38:54Z',
          source: 'defenseworld.net',
          url: 'https://example.com/nvda-insider-sale',
          summary: 'A director sold shares of NVIDIA stock in a recent transaction filing.',
        },
        {
          title: 'Nvidia stock trades near lowest valuation since start of AI boom',
          published_date: '2026-03-27T08:58:10Z',
          source: 'finbold.com',
          url: 'https://example.com/nvda-valuation',
          summary: 'A valuation-focused piece argued Nvidia trades near its lowest valuation of the AI era.',
        },
        {
          title: 'Nvidia Data Center Outlook Seen Underestimated by Analysts',
          published_date: '2026-03-27T12:00:00Z',
          source: 'gurufocus.com',
          url: 'https://example.com/nvda-analysts',
          summary: 'An analyst-focused story said Nvidia data center revenue could be underestimated.',
        },
        {
          title: 'Nvidia-Backed Startup Eyes $2.5 Billion AI Raise',
          published_date: '2026-03-27T09:11:00Z',
          source: 'gurufocus.com',
          url: 'https://example.com/nvda-startup',
          summary: 'A startup funding story mentioned Nvidia because of an ecosystem tie.',
        },
        {
          title: 'Nvidia Targets $1 Trillion in Data Center Revenue -- Wells Fargo Sees 20% Upside',
          published_date: '2026-03-27T11:35:00Z',
          source: 'gurufocus.com',
          url: 'https://example.com/nvda-upside',
          summary: 'An analyst-style story highlighted Nvidia revenue targets and projected upside.',
        },
        {
          title: 'Nvidia stock slips below $170: why analysts see a buying opportunity',
          published_date: '2026-03-27T11:12:52Z',
          source: 'invezz.com',
          url: 'https://example.com/nvda-buying-opportunity',
          summary: 'Nvidia shares remained under pressure as analysts framed the pullback as a buying opportunity.',
        },
        {
          title: "Nvidia won't be dead money for much longer",
          published_date: '2026-03-27T15:16:16Z',
          source: 'seekingalpha.com',
          url: 'https://example.com/nvda-dead-money',
          summary: 'An opinion column argued Nvidia fundamentals are strengthening after months of sideways stock action.',
        },
        {
          title: "Nvidia's new AI tool is giving female game characters a makeover—and gamers are pushing back",
          published_date: '2026-03-27T10:40:04Z',
          source: 'techxplore.com',
          url: 'https://example.com/nvda-ai-tool',
          summary: 'Nvidia announced a new AI rendering tool for games and users reacted to the changes.',
        },
        {
          title: 'NVIDIA and Emerald AI Join Leading Energy Companies to Pioneer Flexible AI Factories as Grid Assets',
          source: 'Press Release',
          url: 'https://example.com/nvda-grid-assets',
          is_press_release: true,
          summary: 'NVIDIA and Emerald AI announced a collaboration around flexible AI factories and grid assets.',
        },
        {
          title: 'Nvidia Stock Has Just Become the Bargain of the AI Boom',
          published_date: '2026-03-27T12:45:56Z',
          source: 'benzinga.com',
          url: 'https://example.com/nvda-bargain',
          summary: 'A valuation-focused commentary piece called Nvidia a bargain within the AI boom.',
        },
      ],
    };

    const result = shapeNewsResponse('NVDA', payload, NVIDIA_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual(expect.arrayContaining([
      "Nvidia's new AI tool is giving female game characters a makeover—and gamers are pushing back",
    ]));
    expect(result.results.map((item) => item.title)).not.toEqual(expect.arrayContaining([
      'Mark Stevens Sells 221,682 Shares of NVIDIA (NASDAQ:NVDA) Stock',
      'Nvidia stock trades near lowest valuation since start of AI boom',
      'Nvidia Data Center Outlook Seen Underestimated by Analysts',
      'Nvidia-Backed Startup Eyes $2.5 Billion AI Raise',
      'Nvidia Targets $1 Trillion in Data Center Revenue -- Wells Fargo Sees 20% Upside',
      'Nvidia stock slips below $170: why analysts see a buying opportunity',
      "Nvidia won't be dead money for much longer",
      'Nvidia Stock Has Just Become the Bargain of the AI Boom',
    ]));
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('omits generic stock-move and peer-comparison chatter for AMD when direct AMD news exists', () => {
    const payload = {
      results: [
        {
          title: 'Advanced Micro Devices, Inc. (AMD) is Attracting Investor Attention: Here is What You Should Know',
          published_date: '2026-03-27T10:02:25Z',
          source: 'zacks.com',
          url: 'https://example.com/amd-attention',
          summary: 'A generic stock-watch article encouraged investors to look at AMD.',
        },
        {
          title: 'Why Advanced Micro Devices Stock is Gaining Today',
          published_date: '2026-03-25T11:17:00Z',
          source: 'fool.com',
          url: 'https://example.com/amd-gaining',
          summary: 'A market-move commentary piece described why AMD shares rose.',
        },
        {
          title: 'Advanced Micro Devices (AMD) Ascends While Market Falls: Some Facts to Note',
          published_date: '2026-03-24T18:46:12Z',
          source: 'zacks.com',
          url: 'https://example.com/amd-ascends',
          summary: 'A generic recap noted AMD outperformed the market in a recent session.',
        },
        {
          title: 'AMD Gives Consumers and Businesses More AI PC Options with Expanded Ryzen AI 400 Series Portfolio',
          source: 'Press Release',
          url: 'https://example.com/amd-ai-pc',
          is_press_release: true,
          summary: 'AMD expanded its Ryzen AI portfolio with new AI PC processors for consumers and businesses.',
        },
        {
          title: 'AMD: Why The CPU Renaissance Is Just Starting',
          published_date: '2026-03-26T09:00:00Z',
          source: 'seekingalpha.com',
          url: 'https://example.com/amd-cpu-renaissance',
          summary: 'An opinion column argued that the CPU renaissance thesis still has room to run for AMD.',
        },
        {
          title: 'Intel Arrow Lake Refresh: The Budget CPU That Finally Gives AMD a Run for Its Money',
          published_date: '2026-03-26T06:45:00Z',
          source: 'fool.com',
          url: 'https://example.com/intel-arrow-lake',
          summary: 'An Intel-focused story mentioned AMD as the benchmark competitor.',
        },
        {
          title: 'Nvidia, AMD Rally As War Fears Ease',
          published_date: '2026-03-23T13:18:00Z',
          source: 'gurufocus.com',
          url: 'https://example.com/nvda-amd-rally',
          summary: 'A broad chip-sector market move story grouped Nvidia and AMD together.',
        },
      ],
    };

    const result = shapeNewsResponse('AMD', payload, AMD_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual(expect.arrayContaining([
      'AMD Gives Consumers and Businesses More AI PC Options with Expanded Ryzen AI 400 Series Portfolio',
    ]));
    expect(result.results.map((item) => item.title)).not.toEqual(expect.arrayContaining([
      'Advanced Micro Devices (AMD) is Attracting Investor Attention: Here is What You Should Know',
      'Why Advanced Micro Devices Stock is Gaining Today',
      'Advanced Micro Devices (AMD) Ascends While Market Falls: Some Facts to Note',
      'AMD: Why The CPU Renaissance Is Just Starting',
      'Intel Arrow Lake Refresh: The Budget CPU That Finally Gives AMD a Run for Its Money',
      'Nvidia, AMD Rally As War Fears Ease',
    ]));
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('omits low-quality index-market chatter for SPY when stronger benchmark reporting exists', () => {
    const payload = {
      results: [
        {
          title: 'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
          published_date: '2026-03-24T08:04:01Z',
          source: 'reuters.com',
          url: 'https://example.com/spy-reuters',
          summary: 'Barclays raised its year-end S&P 500 target despite macro risks.',
        },
        {
          title: 'Nasdaq and S&P 500 set to open lower as oil prices surge as Iran deadline nears',
          published_date: '2026-03-26T08:40:19Z',
          source: 'proactiveinvestors.com',
          url: 'https://example.com/spy-open-lower',
          summary: 'A market-open preview noted futures pointing lower.',
        },
        {
          title: 'More than half of the S&P 500 industry sectors are in correction territory. How much longer until the index itself succumbs?',
          published_date: '2026-03-27T17:46:00Z',
          source: 'marketwatch.com',
          url: 'https://example.com/spy-correction-territory',
          summary: 'A market commentary piece discussed the S&P 500 nearing correction territory.',
        },
        {
          title: 'S&P 500 Snapshot: Index Falls to 6-Month Low',
          published_date: '2026-03-24T13:53:06Z',
          source: 'etftrends.com',
          url: 'https://example.com/spy-snapshot',
          summary: 'A generic snapshot article reviewed the S&P 500 downturn.',
        },
        {
          title: 'S&P 500: US Indices Rally Today as Iran Ceasefire Optimism Sweeps the Market',
          published_date: '2026-03-25T12:54:50Z',
          source: 'fxempire.com',
          url: 'https://example.com/spy-rally-today',
          summary: 'A short-term market move commentary piece on the S&P 500.',
        },
        {
          title: 'These 10 top-rated stocks are crushing the S&P 500 — yet the media and Wall Street ignore them',
          published_date: '2026-03-26T13:00:00Z',
          source: 'marketwatch.com',
          url: 'https://example.com/spy-crushing-the-sp500',
          summary: 'A stock listicle compared underfollowed names against the S&P 500.',
        },
        {
          title: "S&P 500 Falls As Trump's Ceasefire Hopes Dim: Fear & Greed Index Remains In 'Extreme Fear' Zone",
          published_date: '2026-03-25T03:16:53Z',
          source: 'benzinga.com',
          url: 'https://example.com/spy-fear-greed',
          summary: 'A fear-and-greed recap discussed the S&P 500 decline.',
        },
      ],
    };

    const result = shapeNewsResponse('SPY', payload, SPY_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
      'More than half of the S&P 500 industry sectors are in correction territory. How much longer until the index itself succumbs?',
    ]));
    expect(result.results.map((item) => item.title)).not.toEqual(expect.arrayContaining([
      'S&P 500: US Indices Rally Today as Iran Ceasefire Optimism Sweeps the Market',
      'These 10 top-rated stocks are crushing the S&P 500 — yet the media and Wall Street ignore them',
      "S&P 500 Falls As Trump's Ceasefire Hopes Dim: Fear & Greed Index Remains In 'Extreme Fear' Zone",
    ]));
    expect(result._results_meta?.lowSignalOmitted).toBeDefined();
  });

  test('prefers benchmark headlines over ETF comparison listicles for broad-market ETFs', () => {
    const payload = {
      results: [
        {
          title: 'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
          published_date: '2026-03-24T08:04:01Z',
          source: 'reuters.com',
          url: 'https://example.com/spy-reuters-target',
          summary: 'Barclays raised its S&P 500 target despite macro risks and private-credit stress.',
        },
        {
          title: "S&P 500 Is Nearing a Correction. Why Trump's Latest Iran Pause Isn't Helping.",
          published_date: '2026-03-27T06:47:00Z',
          source: 'barrons.com',
          url: 'https://example.com/spy-correction',
          summary: 'Investors appeared to discount the latest effort to calm market angst over the Iran conflict.',
        },
        {
          title: 'IVV vs. SPY: These Top S&P 500 ETFs Are Not the Same',
          published_date: '2026-03-25T12:54:02Z',
          source: 'fool.com',
          url: 'https://example.com/spy-ivv-vs-spy',
          summary: 'A comparison piece contrasted two S&P 500 ETFs.',
        },
        {
          title: 'TSPY: Collect A Double-Digit Yield From The S&P 500 With Tradeoffs',
          published_date: '2026-03-26T21:34:07Z',
          source: 'seekingalpha.com',
          url: 'https://example.com/spy-tspy',
          summary: 'An income ETF article compared TSPY to SPY and SPYI.',
        },
      ],
    };

    const result = shapeNewsResponse('SPY', payload, SPY_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
      "S&P 500 Is Nearing a Correction. Why Trump's Latest Iran Pause Isn't Helping.",
    ]));
    expect(result.results.map((item) => item.title)).not.toEqual(expect.arrayContaining([
      'IVV vs. SPY: These Top S&P 500 ETFs Are Not the Same',
      'TSPY: Collect A Double-Digit Yield From The S&P 500 With Tradeoffs',
    ]));
  });

  test('keeps macro benchmark headlines for SPY even when low-signal wording appears in the title', () => {
    const payload = {
      results: [
        {
          title: 'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
          published_date: '2026-03-24T08:04:01Z',
          source: 'reuters.com',
          url: 'https://example.com/spy-reuters-target-2',
          summary: 'Barclays raised its S&P 500 target despite macro risks and private-credit stress.',
        },
        {
          title: 'More than half of the S&P 500 industry sectors are in correction territory. How much longer until the index itself succumbs?',
          published_date: '2026-03-27T17:46:00Z',
          source: 'marketwatch.com',
          url: 'https://example.com/spy-correction-territory-2',
          summary: 'A market commentary piece discussed the S&P 500 nearing correction territory.',
        },
        {
          title: 'TSPY: Collect A Double-Digit Yield From The S&P 500 With Tradeoffs',
          published_date: '2026-03-26T21:34:07Z',
          source: 'seekingalpha.com',
          url: 'https://example.com/spy-tspy-2',
          summary: 'An income ETF article compared TSPY to SPY and SPYI.',
        },
      ],
    };

    const result = shapeNewsResponse('SPY', payload, SPY_PROFILE) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
      'More than half of the S&P 500 industry sectors are in correction territory. How much longer until the index itself succumbs?',
    ]));
    expect(result.results.map((item) => item.title)).not.toEqual(expect.arrayContaining([
      'TSPY: Collect A Double-Digit Yield From The S&P 500 With Tradeoffs',
    ]));
  });

  test('keeps only direct ETF-specific titles when XLK coverage exists and fallback would otherwise pull unrelated ETF articles', () => {
    const payload = {
      results: [
        {
          title: 'XLK Offers Broader Tech Diversification, While SOXX Targets Semiconductor Stocks. Which Is the Better Investment?',
          published_date: '2026-01-03T13:30:03Z',
          source: 'fool.com',
          url: 'https://example.com/xlk-broader-tech',
          summary: 'XLK is significantly cheaper to own and broader than SOXX, while SOXX is more concentrated in semiconductors.',
        },
        {
          title: 'SPY Turns 33: How Does It Compare to Other S&P 500 ETFs?',
          published_date: '2026-01-22T17:19:39Z',
          source: 'etftrends.com',
          url: 'https://example.com/spy-turns-33',
          summary: 'A broad comparison of S&P 500 ETFs mentioned other funds across the ETF landscape.',
        },
        {
          title: 'Should You Invest in the State Street Technology Select Sector SPDR ETF (XLK)?',
          published_date: '2026-02-11T07:20:28Z',
          source: 'zacks.com',
          url: 'https://example.com/xlk-should-you-invest',
          summary: 'A generic ETF explainer on whether investors should consider XLK.',
        },
        {
          title: 'XLK vs. VGT vs. FTXL: Which Tech ETF Belongs in Your Portfolio?',
          published_date: '2026-03-12T09:41:26Z',
          source: '247wallst.com',
          url: 'https://example.com/xlk-vs-vgt',
          summary: 'A comparison piece framed XLK against rival tech ETFs for portfolio selection.',
        },
      ],
    };

    const result = shapeNewsResponse('XLK', payload, XLK_PROFILE) as {
      results: Array<Record<string, unknown>>;
      _results_meta?: Record<string, unknown>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'XLK Offers Broader Tech Diversification, While SOXX Targets Semiconductor Stocks. Which Is the Better Investment?',
    ]);
    expect(result._results_meta).toMatchObject({ showing: 1, total: 4, relevanceRanked: true });
  });

  test('prefers fund-specific XLK articles over generic ETF comparisons when available', () => {
    const payload = {
      results: [
        {
          title: 'Is Fidelity\'s FTEC a Better Tech ETF Than State Street\'s XLK?',
          published_date: '2026-03-27T16:32:05Z',
          source: 'fool.com',
          url: 'https://example.com/xlk-ftec-better',
          summary: 'XLK and FTEC charge the same low expense ratio but differ in size, with XLK managing far more assets under management.',
        },
        {
          title: 'FTEC Offers Broader Tech Exposure Than XLK, But There\'s a Hidden Downside',
          published_date: '2026-02-01T19:00:02Z',
          source: 'fool.com',
          url: 'https://example.com/xlk-ftec-hidden-downside',
          summary: 'FTEC holds more stocks than XLK and has slightly different volatility characteristics.',
        },
        {
          title: 'Why Short Interest In The Nvidia-Heavy XLK Just Tripled While QQQ Bears Flee',
          published_date: '2026-02-17T12:07:07Z',
          source: 'benzinga.com',
          url: 'https://example.com/xlk-short-interest',
          summary: 'Shares sold short in XLK have jumped from roughly 6.5 million in November to over 18 million by late January.',
        },
        {
          title: 'XLK vs. VGT vs. FTXL: Which Tech ETF Belongs in Your Portfolio?',
          published_date: '2026-03-12T09:41:26Z',
          source: '247wallst.com',
          url: 'https://example.com/xlk-vs-vgt-2',
          summary: 'A comparison piece framed XLK against rival tech ETFs for portfolio selection.',
        },
        {
          title: 'Should You Invest in the State Street Technology Select Sector SPDR ETF (XLK)?',
          published_date: '2026-02-11T07:20:28Z',
          source: 'zacks.com',
          url: 'https://example.com/xlk-should-you-invest-2',
          summary: 'A generic ETF explainer on whether investors should consider XLK.',
        },
      ],
    };

    const result = shapeNewsResponse('XLK', payload, XLK_PROFILE) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Why Short Interest In The Nvidia-Heavy XLK Just Tripled While QQQ Bears Flee',
    ]);
  });

  test('infers broad-market ETF relevance from benchmark-heavy feeds even with a weak SPY profile', () => {
    const payload = {
      results: [
        {
          symbol: 'SPY',
          title: 'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
          published_date: '2026-03-24T08:04:01Z',
          source: 'reuters.com',
          url: 'https://example.com/spy-weak-reuters',
          summary: 'Barclays raised its S&P 500 target despite macro risks and private-credit stress.',
        },
        {
          symbol: 'SPY',
          title: "S&P 500 Is Nearing a Correction. Why Trump's Latest Iran Pause Isn't Helping.",
          published_date: '2026-03-27T06:47:00Z',
          source: 'barrons.com',
          url: 'https://example.com/spy-weak-barrons',
          summary: 'Investors appear to have discounted the latest effort to soothe market angst over Iran.',
        },
        {
          symbol: 'SPY',
          title: "Investors Dump US Stocks Like It's 2008 Again — But Pile Into This Sector At A Record Pace",
          published_date: '2026-03-25T15:47:38Z',
          source: 'benzinga.com',
          url: 'https://example.com/spy-weak-benzinga',
          summary: 'BofA client flow data showed near-record single-stock outflows as geopolitical worries drove a broad selloff.',
        },
      ],
    };

    const result = shapeNewsResponse('SPY', payload, { symbol: 'SPY' }) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
      "S&P 500 Is Nearing a Correction. Why Trump's Latest Iran Pause Isn't Helping.",
    ]);
  });

  test('still infers broad-market ETF relevance when SPY has a weak but present profile name', () => {
    const payload = {
      results: [
        {
          symbol: 'SPY',
          title: 'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
          published_date: '2026-03-24T08:04:01Z',
          source: 'reuters.com',
          url: 'https://example.com/spy-present-profile-reuters',
          summary: 'Barclays raised its S&P 500 target despite macro risks and private-credit stress.',
        },
        {
          symbol: 'SPY',
          title: "S&P 500 Is Nearing a Correction. Why Trump's Latest Iran Pause Isn't Helping.",
          published_date: '2026-03-27T06:47:00Z',
          source: 'barrons.com',
          url: 'https://example.com/spy-present-profile-barrons',
          summary: 'Investors appear to have discounted the latest effort to soothe market angst over Iran.',
        },
        {
          symbol: 'SPY',
          title: "Investors Dump US Stocks Like It's 2008 Again — But Pile Into This Sector At A Record Pace",
          published_date: '2026-03-25T15:47:38Z',
          source: 'benzinga.com',
          url: 'https://example.com/spy-present-profile-benzinga',
          summary: 'BofA client flow data showed near-record single-stock outflows as geopolitical worries drove a broad selloff.',
        },
      ],
    };

    const result = shapeNewsResponse('SPY', payload, {
      symbol: 'SPY',
      company_name: 'SPDR S&P 500',
    }) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results.map((item) => item.title)).toEqual([
      'Barclays raises 2026 year-end S&P 500 target to 7,650 despite Middle East, inflation risks',
      "S&P 500 Is Nearing a Correction. Why Trump's Latest Iran Pause Isn't Helping.",
    ]);
  });

  test('filters weak symbol-tag collisions for sector ETFs even with a sparse XLI profile', () => {
    const payload = {
      results: [
        {
          symbol: 'XLI',
          title: 'Industrial Select Sector SPDR Fund Sees Unusually High Options Volume (NYSEARCA:XLI)',
          published_date: '2026-03-15T02:06:51Z',
          source: 'defenseworld.net',
          url: 'https://example.com/xli-options-volume',
          summary: 'Industrial Select Sector SPDR Fund saw unusual options activity as put volume jumped well above normal levels.',
        },
        {
          symbol: 'XLI',
          title: "Trump's America First Agenda Is Pushing Industrial ETFs like XLI To The Moon",
          published_date: '2026-02-17T15:00:02Z',
          source: '247wallst.com',
          url: 'https://example.com/xli-industrial-etf',
          summary: 'Industrial ETFs have rallied on infrastructure and defense optimism.',
        },
        {
          symbol: 'XLI',
          title: '5 Lessons That Completely Reshaped How I Approach Dividend Investing',
          published_date: '2026-03-26T17:14:07Z',
          source: 'seekingalpha.com',
          url: 'https://example.com/xli-dividend-lessons',
          summary: 'A generic dividend-investing article happened to be tagged to XLI.',
        },
        {
          symbol: 'XLI',
          title: 'KKR Doubles Down On Korea E-Commerce With Logistics Power Play',
          published_date: '2025-12-30T09:13:50Z',
          source: 'benzinga.com',
          url: 'https://example.com/xli-kkr-logistics',
          summary: 'Private equity firm KKR completed a logistics acquisition in South Korea.',
        },
      ],
    };

    const result = shapeNewsResponse('XLI', payload, { symbol: 'XLI' }) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Industrial Select Sector SPDR Fund Sees Unusually High Options Volume (NYSEARCA:XLI)',
      "Trump's America First Agenda Is Pushing Industrial ETFs like XLI To The Moon",
    ]));
  });

  test('still infers sector ETF relevance when XLI has a weak but present profile name', () => {
    const payload = {
      results: [
        {
          symbol: 'XLI',
          title: 'Industrial Select Sector SPDR Fund Sees Unusually High Options Volume (NYSEARCA:XLI)',
          published_date: '2026-03-15T02:06:51Z',
          source: 'defenseworld.net',
          url: 'https://example.com/xli-present-profile-options-volume',
          summary: 'Industrial Select Sector SPDR Fund saw unusual options activity as put volume jumped well above normal levels.',
        },
        {
          symbol: 'XLI',
          title: "Trump's America First Agenda Is Pushing Industrial ETFs like XLI To The Moon",
          published_date: '2026-02-17T15:00:02Z',
          source: '247wallst.com',
          url: 'https://example.com/xli-present-profile-industrial-etf',
          summary: 'Industrial ETFs have rallied on infrastructure and defense optimism.',
        },
        {
          symbol: 'XLI',
          title: '5 Lessons That Completely Reshaped How I Approach Dividend Investing',
          published_date: '2026-03-26T17:14:07Z',
          source: 'seekingalpha.com',
          url: 'https://example.com/xli-present-profile-dividend-lessons',
          summary: 'A generic dividend-investing article happened to be tagged to XLI.',
        },
      ],
    };

    const result = shapeNewsResponse('XLI', payload, {
      symbol: 'XLI',
      company_name: 'Industrial Select Sector SPDR',
    }) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results.map((item) => item.title)).toContain(
      'Industrial Select Sector SPDR Fund Sees Unusually High Options Volume (NYSEARCA:XLI)',
    );
    expect(result.results.map((item) => item.title)).not.toContain(
      '5 Lessons That Completely Reshaped How I Approach Dividend Investing',
    );
  });

  test('filters ambiguous DIA title collisions while keeping real DIA ETF coverage', () => {
    const payload = {
      results: [
        {
          symbol: 'DIA',
          title: 'Element 29 Receives DIA Environmental Certification Advancing Drilling Permit Application at Paka Porphyry-Skarn Cu-Zn-(Au-Ag) Project, Perú',
          published_date: '2026-02-27T08:00:00Z',
          source: 'newsfilecorp.com',
          url: 'https://example.com/dia-environmental-certification',
          summary: 'A mining company announced it had received a DIA environmental certification in Perú.',
          is_press_release: true,
        },
        {
          symbol: 'DIA',
          title: 'Should SPDR Dow Jones Industrial Average ETF (DIA) Be on Your Investing Radar?',
          published_date: '2026-03-02T07:21:07Z',
          source: 'zacks.com',
          url: 'https://example.com/dia-investing-radar',
          summary: 'The SPDR Dow Jones Industrial Average ETF offers broad blue-chip exposure.',
        },
        {
          symbol: 'DIA',
          title: 'Is Dow ETF Better-Positioned Than S&P 500 & Nasdaq Amid Iran War?',
          published_date: '2026-03-16T10:01:28Z',
          source: 'zacks.com',
          url: 'https://example.com/dia-war-rotation',
          summary: 'The Dow ETF may outperform other benchmarks during a rotation into value and defensives.',
        },
      ],
    };

    const result = shapeNewsResponse('DIA', payload, { symbol: 'DIA' }) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results.map((item) => item.title)).toContain(
      'Is Dow ETF Better-Positioned Than S&P 500 & Nasdaq Amid Iran War?',
    );
    expect(result.results.map((item) => item.title)).not.toContain(
      'Element 29 Receives DIA Environmental Certification Advancing Drilling Permit Application at Paka Porphyry-Skarn Cu-Zn-(Au-Ag) Project, Perú',
    );
  });

  test('filters ambiguous DIA collisions when the profile name is present but weak', () => {
    const payload = {
      results: [
        {
          symbol: 'DIA',
          title: 'Element 29 Receives DIA Environmental Certification Advancing Drilling Permit Application at Paka Porphyry-Skarn Cu-Zn-(Au-Ag) Project, Perú',
          published_date: '2026-02-27T08:00:00Z',
          source: 'newsfilecorp.com',
          url: 'https://example.com/dia-present-profile-environmental-certification',
          summary: 'A mining company announced it had received a DIA environmental certification in Perú.',
          is_press_release: true,
        },
        {
          symbol: 'DIA',
          title: 'Should SPDR Dow Jones Industrial Average ETF (DIA) Be on Your Investing Radar?',
          published_date: '2026-03-02T07:21:07Z',
          source: 'zacks.com',
          url: 'https://example.com/dia-present-profile-investing-radar',
          summary: 'The SPDR Dow Jones Industrial Average ETF offers broad blue-chip exposure.',
        },
        {
          symbol: 'DIA',
          title: 'Is Dow ETF Better-Positioned Than S&P 500 & Nasdaq Amid Iran War?',
          published_date: '2026-03-16T10:01:28Z',
          source: 'zacks.com',
          url: 'https://example.com/dia-present-profile-war-rotation',
          summary: 'The Dow ETF may outperform other benchmarks during a rotation into value and defensives.',
        },
      ],
    };

    const result = shapeNewsResponse('DIA', payload, {
      symbol: 'DIA',
      company_name: 'Dow Jones Industrial Average',
    }) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results.map((item) => item.title)).toContain(
      'Is Dow ETF Better-Positioned Than S&P 500 & Nasdaq Amid Iran War?',
    );
    expect(result.results.map((item) => item.title)).not.toContain(
      'Element 29 Receives DIA Environmental Certification Advancing Drilling Permit Application at Paka Porphyry-Skarn Cu-Zn-(Au-Ag) Project, Perú',
    );
  });
});
