import * as puppeteer from 'puppeteer';
import * as https from 'https';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;
const OUTPUT_DIRECTORY = process.env.OUTPUT_DIRECTORY || './downloads';
const START_PAGE_TEXT = process.env.START_PAGE ?? '1';
const START_PAGE = parseInt(START_PAGE_TEXT, 10);

const EXPENSE_TABLE_PRESENCE_SELECTOR = 'body > div.books-app > div > div > div > section > div:nth-child(2) > div > div > section > div:nth-child(4) > div > div > div:nth-child(2) > div > div > div > div > div > div.table-nav.top > div > div.table-search > input';

let browser;
try {
  await makeOutputDirectory(OUTPUT_DIRECTORY);
  browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  await login(page);
  await clickExpense(page);
  if (START_PAGE !== 1) {
    await goToPage(page, START_PAGE);
  }
  let hasMorePages = true;
  while (hasMorePages) {
    await goThroughExpenses(page);
    hasMorePages = await clickOnOlder(page);
  }
} finally {
  if (browser) {
   await browser.close();
  }
}

async function makeOutputDirectory(path) {
  fs.mkdir(path, { recursive: true }, (err) => { if (err) { throw err; } });
}

async function login(page) {
  await page.goto('https://app.kashoo.com/app/login');
  const usernameField = await page.waitForSelector('input#login-username');
  const passwordField = await page.waitForSelector('input#login-password');
  const loginButton = await page.waitForSelector('button#login-submit');

  await page.waitForTimeout(1000);

  await usernameField.type(USERNAME);
  await passwordField.type(PASSWORD);
  await loginButton.click();
}

async function clickExpense(page) {
  await page.waitForSelector('body > div.books-app > div > div > div > nav > div:nth-child(2) > div > div > div > div:nth-child(1) > div > div > section > ul > li:nth-child(1) > a');
  const expenseTab = await page.waitForSelector('body > div.books-app > div > div > div > section > div:nth-child(2) > div > div > section > ul > li:nth-child(2) > a');
  await expenseTab.click();
  await page.waitForSelector(EXPENSE_TABLE_PRESENCE_SELECTOR);
}

async function goThroughExpenses(page) {
  const rowSelector = 'div.panel-table.invoice-records table tbody tr';
  await page.waitForSelector(rowSelector);
  const rows = await page.$$(rowSelector);
  for (let index = 0; index < rows.length; index++) {
    // need to extract the element again as we visit another page and go back
    await page.waitForSelector(rowSelector);
    const currentRows = await page.$$(rowSelector);
    const row = currentRows[index];
    const cells = await row.$$('td');
    const cellContents = await Promise.all(cells.map(cell =>
      page.evaluate(el => ({ html: el.innerHTML, text: el.innerText }), cell)
    ));
    if (!cellContents[1].html.includes('img')) {
      console.log(`Skipping over ${cellContents[0].text}: no attachments`);
      continue;
    }
    console.log(`Visiting ${cellContents[3].text}`);
    await visitAndDownload(page, row, cellContents);
  }
}

async function visitAndDownload(page, row, details) {
  await row.click();
  await page.waitForSelector('input.gwt-FileUpload');
  const receipts = await page.$$('img.gwt-Image');
  console.log(`Found ${receipts.length} receipts`);
  await page.waitForTimeout(200);
  const urls = await Promise.all(receipts.map(receipt => page.evaluate(img => img.src, receipt)));
  const attachmentNameHandles = await page.$$('a.attachment-link');
  const attachmentNames = await Promise.all(attachmentNameHandles.map(h => page.evaluate(el => el.innerText, h)));
  assert.ok(attachmentNames.length === urls.length);

  for (const [index, url] of urls.entries()) {
    const ftype = attachmentNames[index].split('.').pop();
    const [entry, , rawdate, payee] = details.map(d => d.text);
    const date = rawdate.replace(/[ ,]+/g, '.');
    const filename = `${entry}-${date}-${payee}-${index + 1}.${ftype}`;
    await download(url, path.join(OUTPUT_DIRECTORY, filename));
  }
  await page.goBack();
}

async function download(url, filename) {
  console.log(`Downloading ${filename}`);
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const stream = fs.createWriteStream(filename);
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve();
      })
    });
  });
}

async function clickOnOlder(page) {
  const pageNumSelector = 'div.table-nav.top div.ui-form-field input.ui-textbox';
  const pageNumHandle = await page.waitForSelector(pageNumSelector);
  const currentPageNumText = await page.evaluate(h => h.value, pageNumHandle);
  const currentPage = parseInt(currentPageNumText, 10);
  console.log(`current page = ${currentPage}`);
  debugger;

  const totalPagesSelector = 'div.table-nav.top div.ui-form-field span';
  const [, totalPagesHandle] = await page.$$(totalPagesSelector);
  const totalPagesText = await page.evaluate(span => span.innerText, totalPagesHandle);
  const totalPages = parseInt(totalPagesText.replace(/[^0-9]+/g, ''), 10);
  console.log(`total pages = ${totalPages}`);

  if (currentPage === totalPages) {
    return false;
  }

  const navFormSelector = 'div.table-nav.top div.ui-form-field a.gwt-Anchor';
  const [, olderHandle] = await page.$$(navFormSelector);
  await olderHandle.click();
  // we could inject a custom event in the document, as in
  // https://github.com/puppeteer/puppeteer/issues/1333
  // but waiting is enough for me now... most of the latency is for the downloads anyway
  await page.waitForTimeout(1000);
  await page.waitForSelector(EXPENSE_TABLE_PRESENCE_SELECTOR);

  return true;
}

async function goToPage(page, pageNum) {
  const pageNumSelector = 'div.table-nav.top div.ui-form-field input.ui-textbox';
  const pageNumHandle = await page.waitForSelector(pageNumSelector);
  debugger;

  await pageNumHandle.focus();
  await pageNumHandle.press('Backspace');
  await pageNumHandle.type(`${pageNum}\n`);

  await page.waitForTimeout(1000);
  await page.waitForSelector(EXPENSE_TABLE_PRESENCE_SELECTOR);
}

