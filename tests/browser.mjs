import { chromium } from '@playwright/test';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const port=20900+Math.floor(Math.random()*1000),origin=`http://127.0.0.1:${port}`;
const processServer=spawn(process.execPath,['server/index.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,PORT:String(port),LOCAL_DEMO:'true',ALLOW_LIVE_TRADING:'false',SCALPER_ORIGIN:origin},stdio:'pipe'});
let browser;
try{
  for(let n=0;n<100;n++){try{await fetch(origin+'/scalper/api/state');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/scalper/');
  const buy = page.getByRole('button', {name: 'Buy CE · Market', exact: true});
  await buy.waitFor();
  assert.equal(await buy.isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('.price b').textContent !== '—');
  assert.equal(await page.getByRole('combobox', {name: 'PE strike', exact: true}).count(), 0);
  await page.getByRole('button', {name: 'PE', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.price b').textContent !== '—');
  assert.equal(await page.getByRole('combobox', {name: 'CE strike', exact: true}).count(), 0);
  await page.getByText('Fair price', {exact: false}).first().click();
  await page.getByLabel('Entry spot', {exact: true}).fill('24500');
  await page.waitForFunction(() => [...document.querySelectorAll('.fair-results b')].every(el => el.textContent !== '—'));
  await page.getByLabel('Scenario side').selectOption('SELL');
  assert.match(await page.locator('.fair-results span').nth(1).innerText(), /24,475/);
  const entrySpot = page.getByLabel('Entry spot', {exact: true});
  const savedSpots = page.getByLabel('Saved entry spots', {exact: true});
  const saveSpot = page.getByRole('button', {name: 'Save spot', exact: true});
  await saveSpot.click();
  assert.equal(await saveSpot.isDisabled(), true);
  await entrySpot.fill('24625.5');
  await saveSpot.click();
  await page.reload();
  await page.locator('.fair summary').click();
  await savedSpots.selectOption('24500');
  assert.equal(await entrySpot.inputValue(), '24500');
  await page.getByRole('button', {name: 'Delete saved', exact: true}).click();
  assert.equal(await savedSpots.locator('option[value="24500"]').count(), 0);
  assert.equal(await entrySpot.inputValue(), '24500');
  await savedSpots.selectOption('24625.5');
  assert.equal(await entrySpot.inputValue(), '24625.5');
  await page.getByLabel('Underlying', {exact: true}).fill('BANKNIFTY');
  await page.locator('.fair summary').click();
  assert.equal(await savedSpots.isDisabled(), true);
  await page.getByLabel('Underlying', {exact: true}).fill('NIFTY');
  await page.locator('.fair summary').click();
  await savedSpots.selectOption('24625.5');
  await page.locator('.fair summary').click();
  await page.getByLabel('Order type', {exact: true}).selectOption('LIMIT');
  assert.equal(await page.getByLabel('Limit basis').inputValue(), 'LIMIT');
  await page.getByLabel('Order type', {exact: true}).selectOption('MARKET');

  await page.getByLabel('Trading broker').selectOption('zerodha');
  await page.getByRole('region', {name: 'Zerodha account'}).getByText('Connect Zerodha to see its orders.').waitFor();
  await page.getByRole('button', {name: 'Positions', exact: false}).click();
  await page.getByText('Connect Zerodha to see its positions.').waitFor();
  await page.getByRole('button', {name: 'Connection', exact: true}).click();
  await page.getByRole('dialog', {name: 'Broker connection'}).waitFor();
  assert.ok(await page.getByRole('button', {name: 'Generate Kite login'}).isDisabled());
  assert.equal(await page.getByText('ENABLE LIVE', {exact: false}).count(), 0);
  await page.getByRole('button', {name: 'Close settings'}).click();
  await page.getByLabel('Trading broker').selectOption('dhan');
  await page.getByRole('region', {name: 'Dhan account'}).getByText('Connect Dhan to see its positions.').waitFor();

  await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
  const sizes = [[320,568],[390,440],[768,600],[900,480],[1024,768],[1440,900],[2560,1080]];
  const strike = page.getByRole('combobox', {name: 'CE strike', exact: true});
  await page.waitForFunction(() => document.querySelector('.price b').textContent !== '—');
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow at ' + width);
    assert.ok(await page.getByRole('button', {name: 'Cancel pending'}).evaluate(el => el.getBoundingClientRect().bottom < innerHeight));
    await strike.click();
    const list = page.getByRole('listbox', {name: 'CE strikes around ATM'});
    assert.ok(await list.locator('[role=option]').count() > 10);
    assert.ok(await list.evaluate(el => {
      const r = el.getBoundingClientRect(), a = el.querySelector('.atm').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth &&
        Math.abs((a.top + a.bottom - r.top - r.bottom) / 2) < 20;
    }), 'strike list should fit and center ATM');
    await page.keyboard.press('Escape');
    await page.screenshot({path:fileURLToPath(new URL('../test-results/scalper-' + width + 'x' + height + '.png',import.meta.url)),fullPage:true});
  }
  await page.setViewportSize({width:320,height:420});
  await page.getByText('Fair price', {exact: false}).first().click();
  await page.screenshot({path:fileURLToPath(new URL('../test-results/scalper-fair-320.png',import.meta.url)),fullPage:true});
  await page.getByRole('button', {name: 'Connection', exact: true}).click();
  await page.screenshot({path:fileURLToPath(new URL('../test-results/scalper-connection-320.png',import.meta.url)),fullPage:true});
  await page.getByRole('button', {name: 'Close settings'}).click();
  // Exercise populated books and actions through intercepted requests only.
  await page.getByLabel('Trading broker').selectOption('zerodha');
  const selected = await page.getByRole('combobox', {name: 'CE strike', exact: true}).locator('span').first().textContent();
  const contract = (await (await fetch(origin + '/scalper/api/contracts?symbol=NIFTY')).json()).options
    .find(i => i.optionType === 'CE' && i.strike === Number(selected));
  assert.ok(contract);
  const calls = [];
  await page.route('**/scalper/api/state', async route => {
    const response = await route.fetch();
    const original = await response.json();
    const orders = calls.includes('DELETE') ? [] : [{
      ...contract, orderId: 'test-order', productType: 'MIS', variety: 'regular', orderType: 'LIMIT',
      orderStatus: 'PENDING', quantity: contract.lotSize, transactionType: 'BUY', price: 100
    }];
    const positions = [{ ...contract, productType: 'NRML', netQty: contract.lotSize, unrealizedProfit: 24 }];
    await route.fulfill({json:{...original, connected:true, canManage:true, liveReady:true, orders, positions}});
  });
  await page.route('**/scalper/api/orders/test-order', async route => {
    assert.equal(route.request().headers()['x-scalper-broker'], 'zerodha');
    calls.push(route.request().method());
    if (route.request().method() === 'PUT') assert.equal(route.request().postDataJSON().price, 101);
    await route.fulfill({json:{ok:true}});
  });
  await page.route('**/scalper/api/close', async route => {
    assert.equal(route.request().headers()['x-scalper-broker'], 'zerodha');
    assert.equal(route.request().postDataJSON().product, 'NRML');
    calls.push('CLOSE');
    await route.fulfill({json:{ok:true}});
  });
  await page.getByRole('button', {name: 'Orders · 1', exact: true}).click();
  const orderRow = page.getByRole('row').filter({hasText: 'PENDING'});
  await orderRow.dblclick();
  await page.getByRole('button', {name: 'Discard', exact: true}).click();
  await orderRow.focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Limit price', {exact: true}).fill('101');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await page.getByText('Modification requested', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.getByText('Cancellation requested', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Positions · 1', exact: true}).click();
  await page.screenshot({path:fileURLToPath(new URL('../test-results/scalper-positions-320.png',import.meta.url)),fullPage:true});

  await page.getByRole('button', {name: 'Close selected', exact: true}).click();
  await page.getByText('Close order submitted. Check the order book.', {exact: true}).waitFor();
  await page.route('**/scalper/api/cancel-pending', async route => {
    assert.equal(route.request().method(), 'POST');
    calls.push('CANCEL_PENDING');
    await route.fulfill({json:{ok:true}});
  });
  await page.getByRole('button', {name: 'Cancel pending', exact: true}).click();
  await page.getByText('Pending order cancellation processed', {exact: true}).waitFor();
  assert.deepEqual(calls, ['PUT', 'DELETE', 'CLOSE', 'CANCEL_PENDING']);
  const fair=await browser.newPage();
  const frontend=new URL('../../FNO-Analyzer/frontend/',import.meta.url);
  const html=(await readFile(new URL('index.html',frontend),'utf8')).replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link[^>]+>/g,'');
  await fair.route('http://layout.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/dhan/map')return route.fulfill({json:{mapped:[{aoc:'NIFTY',seg:0}]}});
    if(path==='/api/fair-price/expiries')return route.fulfill({json:{expiries:[{label:'30 Oct 2026',id:'test-expiry'}]}});
    if(path==='/api/fair-price/chain')return route.fulfill({json:{snapshot:{uv:24500},refreshed_at:'2026-10-29T08:30:00Z',expires_at:'2099-01-01T00:00:00Z',strikes:[{sp:24500,cLtp:123.45,pLtp:111.25,cD:0.5,pD:-0.5,cG:0.001,pG:0.001,cT:-7,pT:-7}]}});
    return route.fulfill({contentType:'text/html',body:html});
  });
  await fair.goto('http://layout.test/');
  await fair.addStyleTag({content:await readFile(new URL('style.css',frontend),'utf8')});
  await fair.addScriptTag({content:await readFile(new URL('fair-price.js',frontend),'utf8')});
  await fair.evaluate(()=>{document.querySelector('#fairPricePage').classList.remove('hidden');document.querySelector('#chainPage').classList.add('hidden');document.querySelector('.controls').classList.add('hidden');});
  await fair.evaluate(()=>FairPrice.setActive(true));
  await fair.waitForFunction(()=>document.querySelector('.fair-quote').textContent==='123.45');
  for(const [width,height] of sizes){
    await fair.setViewportSize({width,height});
    for(const watchlist of [false,true]){
      await fair.evaluate(open=>{document.body.classList.toggle('watchlist-open',open);document.querySelector('#wlPane').classList.toggle('open',open);},watchlist);
      assert.equal(await fair.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`fair price overflow ${width}x${height}, watchlist ${watchlist}`);
      for(const selector of ['#fairPricePage','.fair-toolbar','.fair-box','.fair-inputs','.fair-contract']){
        for(const element of await fair.locator(selector).all())assert.ok(await element.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`fair price squeezed ${selector} at ${width}`);
      }
    }
    await fair.evaluate(()=>{document.body.classList.remove('watchlist-open');document.querySelector('#wlPane').classList.remove('open');});
    await fair.screenshot({path:fileURLToPath(new URL(`../test-results/fair-${width}x${height}.png`,import.meta.url)),fullPage:true});
  }
  await fair.close();
  assert.deepEqual(errors,[]);
  console.log('Compact layouts, CE/PE toggle, fair price, broker selection, local execution lock and FNO Analyzer layouts passed');
}finally{await browser?.close();processServer.kill();}
