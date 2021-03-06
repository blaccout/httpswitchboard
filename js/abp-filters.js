/*******************************************************************************

    httpswitchboard - a Chromium browser extension to black/white list requests.
    Copyright (C) 2013  Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/httpswitchboard
*/

/******************************************************************************/

(function(){

/*******************************************************************************

Some stats gathered on 2014-03-04

Token size: 1
Dict stats:
	Token count: 10239
	Largest list: "ad /_" has 223 ids

Token size: 2
Dict stats:
	Token count: 10251
	Largest list: "ad /_" has 223 ids

Token size: 3
Dict stats:
	Token count: 10347
	Largest list: "ads //" has 253 ids

*/

var filterDict = {};
var filterCount = 0;

var anyPartyFilters = {}; // any party, anywhere
var thirdPartyFilters = {}; // 3rd party, anywhere

var reIgnoreFilter = /^\[|^!|##|@#|@@|^\|http/;
var reConditionalRule = /\$/;
var reHostnameRule = /^\|\|[a-z0-9.-]+\^?$/;
var reHostnameToken = /^[0-9a-z]+/g;
var reGoodToken = /[%0-9A-Za-z]{2,}/g;
var reAnyToken = /[%0-9A-Za-z]+/g;
var reThirdPartyCondition = /\$third-party$/;

// My favorite regex tester: http://www.gethifi.com/tools/regex#

/******************************************************************************/

var FilterPlain = function(s, tokenBeg) {
    this.s = s;
    this.next = undefined;
    this.tokenBeg = tokenBeg;
};

FilterPlain.prototype.match = function(url, tokenBeg) {
    return url.substr(tokenBeg - this.tokenBeg, this.s.length) === this.s;
};

/******************************************************************************/

var FilterPlainPrefix0 = function(s) {
    this.s = s;
    this.next = undefined;
};

FilterPlainPrefix0.prototype.match = function(url, tokenBeg) {
    return url.substr(tokenBeg, this.s.length) === this.s;
};

/******************************************************************************/

var FilterPlainPrefix1 = function(s) {
    this.s = s;
    this.next = undefined;
};

FilterPlainPrefix1.prototype.match = function(url, tokenBeg) {
    return url.substr(tokenBeg - 1, this.s.length) === this.s;
};

/******************************************************************************/

// With a single wildcard, regex is not optimal.
// See:
//   http://jsperf.com/regexp-vs-indexof-abp-miss/3
//   http://jsperf.com/regexp-vs-indexof-abp-hit/3

var FilterSingleWildcard = function(s, tokenBeg) {
    this.s = s;
    this.next = undefined;
    this.tokenBeg = tokenBeg;
    var wcOffset = s.indexOf('*');
    this.lSegment = s.slice(0, wcOffset);
    this.rSegment = s.slice(wcOffset + 1);
};

FilterSingleWildcard.prototype.match = function(url, tokenBeg) {
    tokenBeg -= this.tokenBeg;
    return url.substr(tokenBeg, this.lSegment.length) === this.lSegment &&
           url.indexOf(this.rSegment, tokenBeg + this.lSegment.length) > 0;
};

/******************************************************************************/

var FilterSingleWildcardPrefix0 = function(s) {
    this.s = s;
    this.next = undefined;
    var wcOffset = s.indexOf('*');
    this.lSegment = s.slice(0, wcOffset);
    this.rSegment = s.slice(wcOffset + 1);
};

FilterSingleWildcardPrefix0.prototype.match = function(url, tokenBeg) {
    return url.substr(tokenBeg, this.lSegment.length) === this.lSegment &&
           url.indexOf(this.rSegment, tokenBeg + this.lSegment.length) > 0;
};

/******************************************************************************/

// With many wildcards, a regex is best.

var FilterManyWildcards = function(s, tokenBeg) {
    this.s = s;
    this.next = undefined;
    this.tokenBeg = tokenBeg;
    // Ref: escaper taken from:
    // https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
    // Except modified for the purpose here.
    this.re = new RegExp('^' + s.replace(/([.+?^=!:${}()|\[\]\/\\])/g, '\\$1').replace(/\*/g, '.*'));
};

FilterManyWildcards.prototype.match = function(url, tokenBeg) {
    return this.re.test(url.slice(tokenBeg - this.tokenBeg));
};

/******************************************************************************/

var FilterFactory = function(s, tokenBeg, tokenLen) {
    var wcOffset = s.indexOf('*');
    if ( wcOffset > 0 ) {
        return FilterWildcardFactory(s, tokenBeg);
    }
    return FilterPlainFactory(s, tokenBeg);
};

var FilterPlainFactory = function(s, tokenBeg) {
    if ( tokenBeg === false ) {
        return new FilterPlainPrefix0(s);
    }
    if ( tokenBeg === 1 ) {
        return new FilterPlainPrefix1(s);
    }
    return new FilterPlain(s, tokenBeg);
};

var FilterWildcardFactory = function(s, tokenBeg) {
    if ( (/\*[^*]\*/).test(s) ) {
        return new FilterManyWildcards(s, tokenBeg);
    }
    if ( tokenBeg === 0 ) {
        return new FilterSingleWildcardPrefix0(s);
    }
    return new FilterSingleWildcard(s, tokenBeg);
};

/******************************************************************************/

// Reset all, thus reducing to a minimum memory footprint of the context.

var reset = function() {
    filterDict = {};
    filterCount = 0;

    // Give chromium's GC a helpful hand
    var collections = [
        thirdPartyFilters,
        anyPartyFilters
    ];
    var filters;
    while ( filters = collections.pop() ) {
        var f, fn;
        for ( var k in filters ) {
            if ( !filters.hasOwnProperty(k) ) {
                continue;
            }
            f = filters[k];
            while ( f ) {
                fn = f.next;
                f.next = null;
                f = fn;
            }
            filters[k] = null;
        }
    }

    thirdPartyFilters = {};
    anyPartyFilters = {};
};

/******************************************************************************/

// Given a string, find a good token. Tokens which are too generic, i.e. very
// common with a high probability of ending up as a miss, are not
// good. Avoid if possible. This has a *significant* positive impact on
// performance.
// These "bad tokens" are collated manually.

var badTokens = {
    'com': true,
    'http': true,
    'https': true,
    'images': true,
    'img': true,
    'js': true,
    'news': true,
    'www': true
};

var findFirstGoodToken = function(s) {
    reGoodToken.lastIndex = 0;
    var matches;
    while ( matches = reGoodToken.exec(s) ) {
        if ( badTokens[matches[0]] === undefined ) {
            return matches;
        }
    }
    // No good token found, just return the first token from left
    reGoodToken.lastIndex = 0;
    return reGoodToken.exec(s);
};

/******************************************************************************/

var findHostnameToken = function(s) {
    reHostnameToken.lastIndex = 0;
    return reHostnameToken.exec(s);
};

/******************************************************************************/

// Trim leading/trailing char "c"

var trimChar = function(s, c) {
    // Remove leading and trailing wildcards
    var pos = 0;
    while ( s.charAt(pos) === c ) {
        pos += 1;
    }
    s = s.slice(pos);
    if ( pos = s.length ) {
        while ( s.charAt(pos-1) === c ) {
            pos -= 1;
        }
        s = s.slice(0, pos);
    }
    return s;
};

/******************************************************************************/

// How the key is derived dictates the number and size of buckets.

var makeKey = function(s) {
    return s;
};

/******************************************************************************/

var add = function(s) {
    // ORDER OF TESTS IS IMPORTANT!

    // Ignore unsupported filters
    if ( reIgnoreFilter.test(s) ) {
        return false;
    }

    // Accept `third-party` condition if it is the only condition
    var thirdParty = reThirdPartyCondition.test(s);
    if ( thirdParty ) {
        s = s.replace('$third-party', '');
    }

    // Ignore rules with other conditions for now
    if ( reConditionalRule.test(s) ) {
        return false;
    }

    // Ignore optionless hostname rules, these will be taken care of by HTTPSB.
    if ( thirdParty === false && reHostnameRule.test(s) ) {
        return false;
    }

    // Ignore some directives for now
    s = s.replace(/\^/g, '*');
    s = s.replace(/\*\*+/g, '*');

    // Remove leading and trailing wildcards
    s = trimChar(s, '*');

    // Remove trailing pipes
    s = s.replace(/\|+$/, '');

    // Already in dictionary?
    var filter = filterDict[s];
    if ( filter !== undefined ) {
        return false;
    }

    // Leading pipe(s) means filter is anchored before the end of hostname
    var hostnameAnchored = s.indexOf('||') === 0;
    s = s.replace(/^\|+/, '');


    if ( thirdParty ) {
        if ( hostnameAnchored ) {
            return addHostnameAnchoredFilter(s, thirdPartyFilters);
        }
        return addAnywhereAnchoredFilter(s, thirdPartyFilters);
    }
    if ( hostnameAnchored ) {
        return addHostnameAnchoredFilter(s, anyPartyFilters);
    }
    return addAnywhereAnchoredFilter(s, anyPartyFilters);
};

/******************************************************************************/

var addHostnameAnchoredFilter = function(s, filterCollection) {
    var matches = findHostnameToken(s);
    if ( !matches || !matches[0].length ) {
        return false;
    }
    return addFilterToCollection(s, matches.index, reHostnameToken.lastIndex, filterCollection);
};

/******************************************************************************/

var addAnywhereAnchoredFilter = function(s, filterCollection) {
    var matches = findFirstGoodToken(s);
    if ( !matches || !matches[0].length ) {
        return false;
    }
    return addFilterToCollection(s, matches.index, reGoodToken.lastIndex, filterCollection);
};

/******************************************************************************/

var addFilterToCollection = function(s, tokenBeg, tokenEnd, filterCollection) {
    var token = s.slice(tokenBeg, tokenEnd);

    var filter = FilterFactory(s, tokenBeg, token.length);
    if ( !filter ) {
        return false;
    }
    filterDict[s] = filter;

    var prefixKey = trimChar(s.substring(tokenBeg - 1, tokenBeg), '*');
    var suffixKey = trimChar(s.substring(tokenEnd, tokenEnd + 2), '*');
    var tokenKey = makeKey(prefixKey + token + suffixKey);

    filter.next = filterCollection[tokenKey];
    filterCollection[tokenKey] = filter;

    filterCount += 1;

    return true;
};

/******************************************************************************/

/*
2014-04-12
Top 20 bucket size:
Histogram anyPartyFilters
	key=/ad_s  count=28
	key=cloudfront.n  count=25
	key=yahoo.c  count=25
	key=/cgi-b  count=24
	key=/wp-c  count=22
	key=amazonaws.c  count=22
	key=/ads/s  count=21
	key=distrowatch.c  count=21
	key=/ads/p  count=18
	key=/ad_l  count=18
	key=/ad_b  count=17
	key=/ads/  count=17
	key=/ads/b  count=17
	key=.gif?  count=17
	key=/ad_c  count=17
	key=messianictimes.c  count=16
	key=/ad_t  count=16
	key=/ad_h  count=15
	key=/ad_f  count=15
	key=/ad_r  count=14
    Total buckets count: 13312

Histogram thirdPartyFilters
	key=doubleclick.n  count=90
	key=facebook.c  count=23
	key=apis.g  count=7
	key=assoc-a  count=7
	key=platform.t  count=6
	key=reddit.c  count=6
	key=draugiem.l  count=6
	key=free-c  count=4
	key=vk.c  count=4
	key=banners.p  count=4
	key=hit-c  count=4
	key=images-a  count=4
	key=ad-s  count=4
	key=a-c  count=4
	key=777-p  count=4
	key=pricegrabber.c  count=4
	key=adultfriendfinder.c  count=4
	key=e-p  count=3
	key=widgets.t  count=3
	key=api.t  count=3 
    Total buckets count: 6244

TL;DR:
    Worst case scenario for `anyPartyFilters` = 28 filters to test
    Worst case scenario for `thirdPartyFilters` = 90 filters to test

    In both collections, worst case scenarios are a very small minority of the
    whole set.
*/
/*
var histogram = function(label, collection) {
    var h = [];
    var n, f;
    for ( var k in collection ) {
        if ( !collection.hasOwnProperty(k) ) {
            continue;
        }
        n = 1;
        f = collection[k];
        while ( f.next ) {
            f = f.next;
            n += 1;
        }
        h.push({ k: k, n: n });
    }
    var total = h.length;
    h.sort(function(a, b) { return b.n - a.n; });
    h = h.slice(0, 20);

    console.log('Histogram %s', label);
    h.forEach(function(v) {
        console.log('\tkey=%s  count=%d', v.k, v.n);
    });
    console.log('\tTotal buckets count: %d', total);
};
*/
/******************************************************************************/

var freeze = function() {
    filterDict = {};
    //histogram('anyPartyFilters', anyPartyFilters);
    //histogram('thirdPartyFilters', thirdPartyFilters);
};

/******************************************************************************/

var matchStringToFilterChain = function(f, url, tokenBeg) {
    while ( f !== undefined ) {
        if ( f.match(url, tokenBeg, tokenBeg) ) {
            // console.log('abp-filters.js> matchStringToFilterChain(): "%s" matches "%s"', f.s, s);
            return f.s;
        }
        f = f.next;
    }
    return false;
};

/******************************************************************************/

var matchStringToFilterCollection = function(filterCollection, url, tokenBeg, tokenEnd) {
    var f;
    var token = url.slice(tokenBeg, tokenEnd);
    var prefixKey = url.substring(tokenBeg - 1, tokenBeg);
    var suffixKey = url.substring(tokenEnd, tokenEnd + 2);
    var matchFn = matchStringToFilterChain;

    if ( suffixKey.length > 1 ) {
        if ( prefixKey !== '' ) {
            f = matchFn(filterCollection[makeKey(prefixKey + token + suffixKey)], url, tokenBeg);
            if ( f !== false ) {
                return f;
            }
        }
        f = matchFn(filterCollection[makeKey(token + suffixKey)], url, tokenBeg);
        if ( f !== false ) {
            return f;
        }
    }
    if ( suffixKey !== '' ) {
        if ( prefixKey !== '' ) {
            f = matchFn(filterCollection[makeKey(prefixKey + token + suffixKey.charAt(0))], url, tokenBeg);
            if ( f !== false ) {
                return f;
            }
        }
        f = matchFn(filterCollection[makeKey(token + suffixKey.charAt(0))], url, tokenBeg);
        if ( f !== false ) {
            return f;
        }
    }
    if ( prefixKey !== '' ) {
        f = matchFn(filterCollection[makeKey(prefixKey + token)], url, tokenBeg);
        if ( f !== false ) {
            return f;
        }
    }
    f = matchFn(filterCollection[makeKey(token)], url, tokenBeg);
    if ( f !== false ) {
        return f;
    }

    return false;
};

/******************************************************************************/

var matchString = function(url, srcDomain, dstHostname) {
    // rhill 2014-03-12: need to skip ABP filtering if HTTP is turned off.
    // https://github.com/gorhill/httpswitchboard/issues/208
    if ( HTTPSB.off ) {
        return false;
    }

    var matches, f;
    var tokenBeg, tokenEnd;
    var thirdParty = dstHostname.lastIndexOf(srcDomain) !== (dstHostname.length - srcDomain.length);

    reAnyToken.lastIndex = 0;
    while ( matches = reAnyToken.exec(url) ) {
        tokenBeg = matches.index;
        tokenEnd = reAnyToken.lastIndex;

        if ( thirdParty ) {
            f = matchStringToFilterCollection(thirdPartyFilters, url, tokenBeg, tokenEnd);
            if ( f !== false ) {
                return f;
            }
        }

        f = matchStringToFilterCollection(anyPartyFilters, url, tokenBeg, tokenEnd);
        if ( f !== false ) {
            return f;
        }
    }

    return false;
};

/******************************************************************************/

var getFilterCount = function() {
    return filterCount;
};

/******************************************************************************/

HTTPSB.abpFilters = {
    add: add,
    freeze: freeze,
    reset: reset,
    matchString: matchString,
    getFilterCount: getFilterCount
};

/******************************************************************************/

})();

/******************************************************************************/
