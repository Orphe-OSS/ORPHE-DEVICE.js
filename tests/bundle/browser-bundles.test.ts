/**
 * orphe-core-insole.js → orphe-core-insole-toolkit.js の順に <script> と同じ形で読み込み、
 * グローバルだけで Toolkit を組み立てられること。圧縮版（.min.js）も同じ確認をする。
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { installDom } from '../helpers/dom.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

before(() => {
  execFileSync('npm', ['run', '--silent', 'build:browser'], { cwd: root, stdio: 'pipe' });
});

for (const suffix of ['.js', '.min.js']) {
  test(`2 本のバンドル（*${suffix}）を順に読み込むと、グローバルから SDK と Toolkit を使える`, () => {
    installDom();
    document.body.innerHTML = '<div id="core"></div><div id="insole"></div>';

    for (const file of [`orphe-core-insole${suffix}`, `orphe-core-insole-toolkit${suffix}`]) {
      vm.runInThisContext(readFileSync(`${root}dist/browser/${file}`, 'utf8'), { filename: file });
    }

    const g = globalThis as Record<string, any>;
    assert.equal(typeof g.OrpheCoreInsoleJS.OrpheCoreInsole, 'function');
    assert.equal(g.Orphe, g.OrpheCoreInsoleJS.Orphe);
    for (const [name, value] of Object.entries(g.OrpheCoreInsoleJS)) {
      if (typeof value === 'function') assert.equal(value.name, name, 'クラス名・関数名が圧縮で変わらない');
    }
    assert.equal(typeof g.OrpheInsoleUtils.computeCoP, 'function');
    assert.ok(g.cores[0] instanceof g.Orphe, 'Toolkit は orphe-core-insole.js のクラスを使う');
    assert.equal(g.bles, g.cores);
    assert.ok(g.insoles[0] instanceof g.OrpheInsole);

    g.buildCoreToolkit(document.getElementById('core'), 'CORE', 0);
    g.buildInsoleToolkit(document.getElementById('insole'), 'INSOLE', 1, { onError() {} });
    assert.ok(document.getElementById('switch_ble0'));
    assert.ok(document.getElementById('settings_modal1'));
    assert.ok(g.getInsoleToolkitSession(1) instanceof g.InsoleToolkitSession);
    assert.equal(typeof g.changeNotify, 'function', '設定モーダルの onchange から呼ばれる関数');
    assert.equal(typeof g.insoleToolkitMeasurementToCSV, 'function');

    assert.equal(g.orpheCore, null);
    const companion = g.buildCoreCompanionToolkit(document.getElementById('core'), 'COMPANION');
    assert.ok(companion instanceof g.Orphe);
    assert.equal(g.orpheCore, companion);
  });
}
