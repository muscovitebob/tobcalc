import { SecurityType, CurrencyCode, Security } from "./enums.ts";
import { InformativeError } from "./InformativeError.ts";

// Why do we need these variables and not make them constants?
// Browsers will not be able to make requests to these origins
// due to CORS, so the way to make this script work in a
// web app is to change these variables to proxies for the
// original hostnames
let ECB_HOSTNAME = "sdw-wsrest.ecb.europa.eu";
let YAHOO_FINANCE_QUERY1_HOSTNAME = "query1.finance.yahoo.com";
let YAHOO_FINANCE_HOSTNAME = "finance.yahoo.com";

export function setECBHostname(hostname: string) {
    ECB_HOSTNAME = hostname;
}

export function setYahooFinanceQuery1Hostname(hostname: string) {
    YAHOO_FINANCE_QUERY1_HOSTNAME = hostname;
}

export function setYahooFinanceHostname(hostname: string) {
    YAHOO_FINANCE_HOSTNAME = hostname;
}

interface ECBTimePeriod {
    id: string;
    name: string;
    start: string;
    end: string;
}

export function formatDate(date: Date): string {
    const addZero = (num: number): string => {
        return num < 10 ? `0${num}` : `${num}`;
    };
    return `${date.getFullYear()}-${addZero(date.getMonth() + 1)}-${addZero(date.getDate())}`;
}

// A two-dimensional `Map` where each key in the first dimension is a currency code
// and each key in the second dimension being a date formatted in YYYY-MM-DD and finally,
// the value of each entry in the second dimension being the exchange rate
export type ExchangeRatesMap = Map<CurrencyCode, Map<string, number>>;
export const exchangeRatesMap: ExchangeRatesMap = new Map();

// Caches data in exchangesRatesMap
export async function cacheExchangeRates(start: Date, end: Date, currencyCode: CurrencyCode) {
    // See https://sdw-wsrest.ecb.europa.eu/help/

    const startPeriod = formatDate(start);
    const endPeriod = formatDate(end);
    const params = {
        startPeriod,
        endPeriod,
        format: "jsondata",
        detail: "dataonly",
        dimensionAtObservation: "AllDimensions",
    };
    const urlParamsString = new URLSearchParams(params).toString();

    let requestCurrencyCode: CurrencyCode = currencyCode;
    if(currencyCode === CurrencyCode.GBX) {
        requestCurrencyCode = CurrencyCode.GBP;
    }

    const response = await fetch(`https://${ECB_HOSTNAME}/service/data/EXR/D.${requestCurrencyCode}.EUR.SP00.A?${urlParamsString}`);
    if(response.status !== 200) {
        throw new Error(`response from ECB RESTful API returned status code ${response.status}`);
    }
    const json = await response.json();

    let foundTimePeriods = false;
    let timePeriods: ECBTimePeriod[] = [];
    for(const observation of json.structure.dimensions.observation) {
        if(observation.id === "TIME_PERIOD") {
            timePeriods = observation.values;
            foundTimePeriods = true;
            break;
        }
    }
    if(!foundTimePeriods) {
        throw new Error(`could not find time periods for start date ${startPeriod}, end date ${endPeriod} and currencyCodes ${currencyCode}`);
    }

    let currencyMap = exchangeRatesMap.get(currencyCode);
    if(currencyMap === undefined) {
        currencyMap = new Map();
        exchangeRatesMap.set(currencyCode, currencyMap);
    }
    for(let i = 0; i < timePeriods.length; i++) {
        const date = timePeriods[i].name;
        let exchangeRate = <number> json.dataSets[0].observations[`0:0:0:0:0:${i}`][0];

        if(currencyCode === CurrencyCode.GBX) {
            exchangeRate = exchangeRate * 100;
        }

        currencyMap.set(date, exchangeRate);
    }
}

const isinsMap: Map<string, Security> = new Map();
// Returns a `Map` where each ISIN from `isins` maps to a `SecurityType`
export async function getSecurity(isin: string): Promise<Security> {
    let security = isinsMap.get(isin);
    if(security !== undefined) {
        return security;
    }

    const response = await fetch(`https://${YAHOO_FINANCE_QUERY1_HOSTNAME}/v1/finance/search?q=${isin}&quotesCount=1&newsCount=0`);

    if(response.status !== 200) {
        throw new InformativeError("security.fetch.response_code", { status: response.status, isin });
    }

    const json = await response.json();
    if(json.quotes === undefined) {
        throw new InformativeError("security.fetch.response_format", { isin, json });
    }
    if(json.quotes.length !== 1) {
        throw new InformativeError("security.fetch.not_found", { isin, json });
    }

    const { quoteType, longname: name, symbol } = json.quotes[0];
    switch(quoteType) {
        case "MUTUALFUND":
        case "ETF":
            const securityDataResponse = await fetch(`https://${YAHOO_FINANCE_HOSTNAME}/quote/${symbol}`);
            const html = await securityDataResponse.text();
            const accumulating = /data-test="TD_YIELD-value">0\.00%<\/td/g.test(html) || /data-test="TD_YIELD-value">N\/A<\/td/g.test(html);
            security = {
                type: SecurityType.ETF,
                name,
                accumulating,
            };
            break;
        case "EQUITY":
            security = {
                type: SecurityType.Stock,
                name,
            };
            break;
        default:
            throw new InformativeError("security.fetch.unknown_quote_type", { quoteType });
    }

    isinsMap.set(isin, security);
    return security;
}
