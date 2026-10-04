#!/usr/bin/env node
/*
 * Headless Chrome runner for the jQuery QUnit suite (test/index.html).
 *
 * The suite needs PHP for its ajax/support fixtures, so the repository root
 * must already be served by PHP, e.g.:
 *
 *   PHP_CLI_SERVER_WORKERS=8 php -S 127.0.0.1:8000 -t <repo root>
 *
 * Each module (default: the `testswarm.tests` list from Gruntfile.js) is run
 * on its own page (test/index.html?module=<name>) in a fresh browser context,
 * once per requested build variant:
 *
 *   min - default page, loads dist/jquery.min.js (the shipped minified build)
 *   dev - ?dev=true, loads dist/jquery.js (the unminified build)
 *
 * QUnit 1.x logging callbacks are hooked before any test runs; the runner
 * prints one line per module, every failing assertion, and a final summary:
 *
 *   QUnit: X tests, Y assertions, Z passed, W failed
 *
 * An attempt is bad if it has a failed assertion, an uncaught page error, no
 * tests, or times out. A bad module run is retried (--retries, default 1) on
 * a fresh browser context; the first attempt's failures stay in the log and
 * are marked with a RETRY line. Only the final attempt of each module counts
 * towards the summary, and modules that passed only on retry are listed as
 * flaky. Exit code is 0 only if the final attempt of every module is good;
 * otherwise it is 1.
 *
 * This is a Node script, not a browser test: it is excluded from grunt's
 * jshint run via .jshintignore.
 *
 * Options (all optional):
 *   --base-url <url>         server root (env BASE_URL, default http://127.0.0.1:8000)
 *   --variants <list>        comma list of min,dev (env VARIANTS, default min,dev)
 *   --modules <list>         comma list of QUnit modules (env MODULES, default: Gruntfile testswarm list)
 *   --module-timeout <secs>  per-module page timeout (env MODULE_TIMEOUT, default 600)
 *   --retries <n>            re-runs of a bad module run (env RETRIES, default 1)
 *   --chrome <path>          Chrome/Chromium binary (env CHROME_BIN, default: first one on PATH)
 */
"use strict";

const fs = require( "fs" );
const path = require( "path" );
const { execFileSync } = require( "child_process" );
const puppeteer = require( "puppeteer-core" );

const repoRoot = path.resolve( __dirname, "..", ".." );

function parseArgs( argv ) {
	const opts = {};
	for ( let i = 0; i < argv.length; i++ ) {
		const m = /^--([a-z-]+)(?:=(.*))?$/.exec( argv[ i ] );
		if ( !m ) {
			throw new Error( "Unknown argument: " + argv[ i ] );
		}
		opts[ m[ 1 ] ] = m[ 2 ] !== undefined ? m[ 2 ] : argv[ ++i ];
	}
	return opts;
}

function splitList( value ) {
	return String( value ).split( /[\s,]+/ ).filter( Boolean );
}

// Keep the module list in sync with Gruntfile.js `testswarm.tests`
function gruntfileModules() {
	const src = fs.readFileSync( path.join( repoRoot, "Gruntfile.js" ), "utf8" );
	const m = /testswarm\s*:\s*\{[^}]*?tests\s*:\s*"([^"]+)"/.exec( src );
	if ( !m ) {
		throw new Error( "Could not find testswarm.tests in Gruntfile.js; pass --modules" );
	}
	return splitList( m[ 1 ] );
}

function findChrome( explicit ) {
	if ( explicit ) {
		return explicit;
	}
	const candidates = [ "google-chrome-stable", "google-chrome", "chromium", "chromium-browser" ];
	for ( const name of candidates ) {
		try {
			return execFileSync( "which", [ name ], { encoding: "utf8" } ).trim();
		} catch ( e ) {
			// try next
		}
	}
	throw new Error( "No Chrome/Chromium found on PATH; set CHROME_BIN or pass --chrome" );
}

async function waitForServer( baseUrl, timeoutMs ) {
	// A PHP endpoint, so this also proves PHP (not just static files) is served
	const probe = baseUrl + "/test/data/name.php?name=foo";
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while ( Date.now() < deadline ) {
		try {
			const res = await fetch( probe );
			const body = await res.text();
			if ( res.ok && body === "bar" ) {
				return;
			}
			lastError = new Error( "HTTP " + res.status + " body=" + JSON.stringify( body.slice( 0, 200 ) ) );
		} catch ( e ) {
			lastError = e;
		}
		await new Promise( ( r ) => setTimeout( r, 500 ) );
	}
	throw new Error( "PHP server not ready at " + probe + ": " + ( lastError && lastError.message ) );
}

// Runs in the page before any page script. Hooks QUnit's logging callbacks
// as soon as qunit.js assigns window.QUnit (top frame only; iframes reuse
// parent.QUnit) and streams results to Node through window.__qunitReport.
function pageHook() {
	if ( window.top !== window ) {
		return;
	}
	let current;
	let hooked = false;

	function report( payload ) {
		try {
			window.__qunitReport( JSON.stringify( payload ) );
		} catch ( e ) {
			// binding not ready; nothing else we can do
		}
	}

	function dump( value ) {
		try {
			return window.QUnit.jsDump.parse( value );
		} catch ( e ) {
			try {
				return String( value );
			} catch ( e2 ) {
				return "<unprintable>";
			}
		}
	}

	function hook( Q ) {
		if ( hooked || !Q || typeof Q.log !== "function" ) {
			return;
		}
		hooked = true;
		Q.begin( function( d ) {
			report( { type: "begin", totalTests: d && d.totalTests } );
		} );
		Q.log( function( d ) {
			if ( d.result ) {
				return;
			}
			report( {
				type: "assertFail",
				module: d.module,
				name: d.name,
				message: d.message == null ? "" : String( d.message ),
				hasExpected: Object.prototype.hasOwnProperty.call( d, "expected" ),
				expected: dump( d.expected ),
				actual: dump( d.actual ),
				source: d.source || ""
			} );
		} );
		Q.testDone( function( d ) {
			report( {
				type: "testDone",
				module: d.module,
				name: d.name,
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				duration: d.duration
			} );
		} );
		Q.done( function( d ) {
			report( {
				type: "done",
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return current;
		},
		set: function( value ) {
			current = value;
			hook( value );
		}
	} );
}

function fmtSecs( ms ) {
	return ( ms / 1000 ).toFixed( 1 ) + "s";
}

function indent( text ) {
	return String( text ).replace( /\n/g, "\n        " );
}

// Reasons an attempt is not a clean pass (empty array = good)
function problems( result ) {
	const reasons = [];
	if ( result.failed ) {
		reasons.push( result.failed + " failed assertion" + ( result.failed === 1 ? "" : "s" ) );
	}
	if ( result.pageErrors.length ) {
		reasons.push( result.pageErrors.length + " page error" + ( result.pageErrors.length === 1 ? "" : "s" ) );
	}
	if ( result.error ) {
		reasons.push( result.error );
	}
	return reasons;
}

async function runModule( browser, opts, variant, moduleName, attempt ) {
	const query = "module=" + encodeURIComponent( moduleName ) + ( variant === "dev" ? "&dev=true" : "" );
	const url = opts.baseUrl + "/test/index.html?" + query;
	const label = "[" + variant + "] " + moduleName + ( attempt > 1 ? " (attempt " + attempt + ")" : "" );
	const result = {
		variant, module: moduleName, url, attempt,
		tests: 0, failedTests: 0, assertions: 0, passed: 0, failed: 0,
		failures: [], pageErrors: [], done: null, error: null, started: Date.now()
	};

	const context = await browser.createBrowserContext();
	try {
		const page = await context.newPage();
		await page.setViewport( { width: 1280, height: 1024 } );

		let resolveDone;
		const donePromise = new Promise( ( r ) => {
			resolveDone = r;
		} );

		await page.exposeFunction( "__qunitReport", ( json ) => {
			const ev = JSON.parse( json );
			if ( ev.type === "assertFail" ) {
				result.failures.push( ev );
				let line = "  FAIL " + label + " > " + ev.module + " > " + ev.name +
					"\n      message:  " + indent( ev.message || "(no message)" );
				if ( ev.hasExpected ) {
					line += "\n      expected: " + indent( ev.expected ) +
						"\n      actual:   " + indent( ev.actual );
				}
				if ( ev.source ) {
					line += "\n      source:   " + indent( ev.source.split( "\n" )[ 0 ].trim() );
				}
				console.log( line );
			} else if ( ev.type === "testDone" ) {
				result.tests++;
				result.assertions += ev.total;
				result.passed += ev.passed;
				result.failed += ev.failed;
				if ( ev.failed ) {
					result.failedTests++;
				}
			} else if ( ev.type === "done" ) {
				result.done = ev;
				resolveDone();
			}
		} );
		await page.evaluateOnNewDocument( pageHook );

		page.on( "pageerror", ( err ) => {
			const message = String( err && err.message || err );
			result.pageErrors.push( message );
			console.log( "  [page error] " + label + ": " + message );
		} );
		page.on( "dialog", ( dialog ) => {
			console.log( "  [dialog] " + label + ": " + dialog.message() );
			dialog.dismiss().catch( () => {} );
		} );

		await page.goto( url, { waitUntil: "load", timeout: 60000 } );
		await page.bringToFront();

		let timer;
		const timedOut = await Promise.race( [
			donePromise.then( () => false ),
			new Promise( ( r ) => {
				timer = setTimeout( () => r( true ), opts.moduleTimeoutMs );
			} )
		] );
		clearTimeout( timer );
		if ( timedOut ) {
			result.error = "timed out after " + fmtSecs( opts.moduleTimeoutMs ) + " waiting for QUnit.done";
		}
	} catch ( e ) {
		result.error = "runner error: " + ( e && e.stack || e );
	} finally {
		await context.close().catch( () => {} );
	}

	result.elapsed = Date.now() - result.started;
	if ( !result.error && result.done && result.done.total !== result.assertions ) {
		result.error = "QUnit.done reported " + result.done.total + " assertions but testDone summed to " +
			result.assertions;
	}
	if ( !result.error && result.tests === 0 ) {
		result.error = "no tests ran (unknown module name?)";
	}

	const reasons = problems( result );
	console.log( label + ": " + result.tests + " tests, " + result.assertions + " assertions, " +
		result.passed + " passed, " + result.failed + " failed (" + fmtSecs( result.elapsed ) + ") " +
		( reasons.length ? "FAILED - " + reasons.join( "; " ) : "ok" ) );
	return result;
}

// Run a module, retrying a bad attempt up to opts.retries times on a fresh
// browser context. Returns the final attempt, with `attempts` set.
async function runModuleWithRetries( browser, opts, variant, moduleName ) {
	let result;
	for ( let attempt = 1; ; attempt++ ) {
		result = await runModule( browser, opts, variant, moduleName, attempt );
		const reasons = problems( result );
		if ( !reasons.length || attempt > opts.retries ) {
			break;
		}
		console.log( "RETRY [" + variant + "] " + moduleName + " (attempt " + attempt + " failed: " +
			reasons.join( "; " ) + ")" );
	}
	result.attempts = result.attempt;
	return result;
}

async function main() {
	const args = parseArgs( process.argv.slice( 2 ) );
	const opts = {
		baseUrl: ( args[ "base-url" ] || process.env.BASE_URL || "http://127.0.0.1:8000" ).replace( /\/+$/, "" ),
		variants: splitList( args.variants || process.env.VARIANTS || "min,dev" ),
		modules: args.modules || process.env.MODULES ?
			splitList( args.modules || process.env.MODULES ) :
			gruntfileModules(),
		moduleTimeoutMs: Number( args[ "module-timeout" ] || process.env.MODULE_TIMEOUT || 600 ) * 1000,
		retries: Number( args.retries !== undefined ? args.retries :
			process.env.RETRIES !== undefined && process.env.RETRIES !== "" ? process.env.RETRIES : 1 ),
		chrome: findChrome( args.chrome || process.env.CHROME_BIN )
	};
	if ( !Number.isInteger( opts.retries ) || opts.retries < 0 ) {
		throw new Error( "--retries must be a non-negative integer" );
	}
	for ( const v of opts.variants ) {
		if ( v !== "min" && v !== "dev" ) {
			throw new Error( "Unknown variant " + v + " (expected min or dev)" );
		}
	}

	console.log( "Server:   " + opts.baseUrl );
	console.log( "Chrome:   " + opts.chrome );
	console.log( "Variants: " + opts.variants.join( ", " ) );
	console.log( "Modules:  " + opts.modules.join( " " ) );
	console.log( "Retries:  " + opts.retries );

	await waitForServer( opts.baseUrl, 30000 );

	const browser = await puppeteer.launch( {
		executablePath: opts.chrome,
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--window-size=1280,1024",
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding"
		]
	} );
	console.log( "Browser:  " + await browser.version() );
	console.log( "" );

	const results = [];
	try {
		for ( const variant of opts.variants ) {
			for ( const moduleName of opts.modules ) {
				results.push( await runModuleWithRetries( browser, opts, variant, moduleName ) );
			}
		}
	} finally {
		await browser.close().catch( () => {} );
	}

	// Everything below uses only the final attempt of each module
	const sum = ( key ) => results.reduce( ( n, r ) => n + r[ key ], 0 );
	const name = ( r ) => "[" + r.variant + "] " + r.module;
	const broken = results.filter( ( r ) => problems( r ).length );
	const flaky = results.filter( ( r ) => r.attempts > 1 && !problems( r ).length );

	console.log( "" );
	if ( broken.length ) {
		console.log( "Failed modules:" );
		for ( const r of broken ) {
			console.log( "  " + name( r ) + " after " + r.attempts + " attempt" + ( r.attempts === 1 ? "" : "s" ) +
				": " + problems( r ).join( "; " ) );
			for ( const f of r.failures ) {
				console.log( "    - " + f.module + " > " + f.name + ": " + ( f.message || "(no message)" ) );
			}
			for ( const message of r.pageErrors ) {
				console.log( "    - page error: " + message );
			}
		}
		console.log( "" );
	}
	console.log( "QUnit: " + sum( "tests" ) + " tests, " + sum( "assertions" ) + " assertions, " +
		sum( "passed" ) + " passed, " + sum( "failed" ) + " failed" +
		" (" + sum( "failedTests" ) + " failed tests, " + broken.length + " failed modules, " +
		results.length + " module runs)" );
	console.log( "Flaky (passed on retry): " + ( flaky.length ? flaky.map( name ).join( ", " ) : "none" ) );

	process.exitCode = broken.length ? 1 : 0;
}

main().catch( ( e ) => {
	console.error( e && e.stack || e );
	process.exitCode = 1;
} );
