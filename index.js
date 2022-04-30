#!/usr/bin/env node

const yargs = require('yargs/yargs');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { google } = require('googleapis');
const fastcsv = require('fast-csv');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

async function authorize(serviceAccount) {
    const credentials = JSON.parse(fs.readFileSync(path.resolve((serviceAccount.indexOf(path.sep) < 0 ? (os.homedir() + path.sep + '.gdrive' + path.sep) : '') + serviceAccount), 'utf-8'));
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    return google.auth.getClient({ credentials, scopes: SCOPES });
}

async function readInfo(sheets, sheetId, worksheet, firstCol, lastCol) {
    if (!sheetId) {
        throw new Error('sheetId is needed');
    }
    if (!lastCol) {
        throw new Error('lastCol is needed');
    }
    const result = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: ((worksheet ? (worksheet + '!') : '') + (firstCol || 'A') + ':' + lastCol), //'Sheet2!A1:C1001',
        valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const vals = result.data.values;
    const valsJson = vals
        .filter((v, i) => i > 0)
        .map(v => {
            const r = {};
            vals[0].forEach((f, i) => r[f] = v[i]);
            return r;
        });
    return valsJson;
}

async function getHeaders(sheets, sheetId, worksheet, firstCol, lastCol) {
    const headers = await sheets.spreadsheets.values.get({
        spreadsheetId: '1aXf_kiHOOu1vbMPlrAYNAI2nTRWEdg1P7HLTXkagKB8',
        range: 'Sheet2!A1:C1',
        valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return headers.data.values[0];
}

async function appendInfo(sheets, rows, sheetId, worksheet, firstCol, lastCol) {
    
    const headers = await getHeaders(sheets);
    const result = await sheets.spreadsheets.values.append({
        spreadsheetId: '1aXf_kiHOOu1vbMPlrAYNAI2nTRWEdg1P7HLTXkagKB8',
        range: 'Sheet2!A:C',
        valueInputOption: 'RAW',
        resource: {
            values: rows.map(r => headers.map(h => (undefined === r[h]) ? null: r[h])),
        },
    });
}

async function updateInfo(sheets, rows, filterCols, sheetId, worksheet, firstCol, lastCol) {
    if (filterCols.length < 1) {
        throw new Error('Need at least one filter col');
    }
    const headers = await getHeaders(sheets);
    const currentVals = await readInfoImpl(sheets);
    const updateSpecs = rows.map((r, i) => { // {range, values} or null
        let found = 0; // (0 = not found)
        let existVal = null;
        currentVals.forEach((currentVal, ii) => {
            if (filterCols.filter(h => (((currentVal[h] !== undefined) && (r[h] !== undefined)) && (currentVal[h] === r[h]))).length === filterCols.length) {
                found = ii + 2; // (row 2 is first) 
                existVal = currentVal;
            }
        });
        const newRow = {...existVal, ...r};
        if (found >= 1) {
            console.log('Found row ' + found + ' for item #' + i);
            return {
                range: 'Sheet2!A' + found + ':C' + found,
                values: [headers.map(h => (undefined === newRow[h]) ? null: newRow[h])],
            };
        } else {
            console.log('Cannot find row for item #' + i);
            return null;
        }
    }).filter(updateSpec => !!updateSpec);
    if (updateSpecs.length > 0) {
        const result = await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: '1aXf_kiHOOu1vbMPlrAYNAI2nTRWEdg1P7HLTXkagKB8',
            valueInputOption: 'RAW',
            resource: {
                valueInputOption: 'RAW',
                data: updateSpecs,
            }
        });
    }
}

const argv = yargs(process.argv.slice(2))
    .locale('en-US')
    .usage('Access a gsheet from the command line\ngsheet read|append|update --service-account <file> [--csv] [--format-json] --sheet <id> [--worksheet <name>] [--firstCol=A] --lastCol=<B or right> [--lookup-cols <col>[,<col>]] --file <file>|-')
    .command('read', 'Read gsheet and return as JSON (or CSV)')
    .command('append', 'Apend JSON (or CSV) to gsheet - proprety names = column names')
    .command('update', 'Update gsheet from JSON (or CSV) - proprety names = column names; needs --lookup-cols to be given')
    .option('service-account', {describe: 'File name of service account file - either path or in ~/.gdrive/ (same as gdrive)', type: 'string', nargs: 1})
    .option('csv', {describe: 'Read output / append/update input is CSV (not JSON)', type: 'boolean'})
    .option('format-json', {describe: 'Format the JSON output (JSON only)', type: 'boolean'})
    .option('sheet', {describe: 'ID of the gsheet (last part of URL)', type: 'string', nargs: 1})
    .option('worksheet', {describe: 'Name of the worksheet (defaults to first worksheet)', type: 'string', nargs: 1})
    .option('first-col', {describe: 'First column in the worksheet to look at (defaults to A)', type: 'string', nargs: 1})
    .option('last-col', {describe: 'Last column in the worksheet to look at (B or right of it)', type: 'string', nargs: 1})
    .option('lookup-cols', {describe: 'Name(s) of columns to perform lookup on, need to be defined in JSON (or CSV)', type: 'string', nargs: 1})
    .option('file', {describe: 'Read output / append/update input file name; - for stdout / stdin', type: 'string', nargs: 1})
    .demandCommand(1)
    .demandOption(['service-account', 'sheet', 'file', 'lastCol']).argv;


// now finally do it
async function doIt(argv) {
    const auth = await authorize(argv.serviceAccount);
    const sheets = google.sheets({ version: 'v4', auth });
    if ('read' === argv._[0]) {
        const valsJson = await readInfo(sheets, argv.sheet, argv.worksheet, argv.firstCol, argv.lastCol);
        if ('-' === argv.file) {
            if (argv.csv) {
                await fastcsv.writeToStream(process.stdout, valsJson, {headers: true});
            } else {
                process.stdout.write(JSON.stringify(valsJson, null, argv.formatJson ? '  ' : undefined));
            }
        } else {
            if (argv.csv) {
                await fastcsv.writeToPath(path.resolve(argv.file), valsJson, {headers: true});
            } else {
                fs.writeFileSync(path.resolve(argv.file), JSON.stringify(valsJson, null, argv.formatJson ? '  ' : undefined), 'utf-8');
            }
        }
    } else if ('append' === argv._[0]) {

    } else if ('update' === argv._[0]) {

    } else {
        throw new Error('Command must be read|append|update');
    }
    //TODO: await appendInfo(auth, [{"Name": "Bart", "Email": "bs@ts.com", "Budget": 42}]);
    //TODO: await updateInfo(auth, [{"Name": "Marge", "Budget": 40}], ['Name']);
}
doIt(argv);
