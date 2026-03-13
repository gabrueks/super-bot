import { SentimentData } from '../types';
import { log, logError } from '../logger';

const FNG_URL = 'https://api.alternative.me/fng/?limit=1';

export async function fetchFearAndGreed(): Promise<SentimentData> {
  log('SENTIMENT', 'Fetching Fear & Greed Index...');

  try {
    const response = await fetch(FNG_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const json = await response.json() as {
      data: Array<{ value: string; value_classification: string; timestamp: string }>;
    };

    const entry = json.data?.[0];
    if (!entry) {
      throw new Error('Empty response from Fear & Greed API');
    }

    const sentiment: SentimentData = {
      value: parseInt(entry.value, 10),
      label: entry.value_classification,
      timestamp: parseInt(entry.timestamp, 10) * 1000,
    };

    log('SENTIMENT', `Fear & Greed: ${sentiment.value} (${sentiment.label})`);
    return sentiment;
  } catch (err) {
    logError('SENTIMENT', 'Failed to fetch Fear & Greed Index, using neutral default', err);
    return {
      value: 50,
      label: 'Neutral',
      timestamp: Date.now(),
    };
  }
}
