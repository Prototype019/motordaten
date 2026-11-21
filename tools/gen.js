'use strict';
/**
 * Writes each app's staged package tree (apps/<id>/package/) from its
 * apps/<id>/spec.js: package.json, npm-shrinkwrap.json, manifest.json (the
 * platform proxies of tools/base-manifest.json plus the spec's own),
 * permissions.json, config/base.json, rhmiData/application.json, the iDrive 8
 * UI (uiDescriptions/ID8) and the RHMI text files. Every module an app lists
 * as src/<name> that shared/<name> has is copied from there (the list screen,
 * the diagnostic link, the value tables). Run after every change:
 *
 *   node tools/gen.js            every app
 *   node tools/gen.js <id>       one app
 *
 * iDrive 8 widgets: LT_State_Wide_List states,
 * LT_ScrollLabel labels, LT_Button_MediaEntry_1Row buttons and rows
 * (PrimaryText left, FrequencyText right); a list is one row component whose
 * row count the app sets at runtime. No state has a ParentState (Hmi8 refuses
 * nested parents).
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const APPS = path.join(REPO, 'apps');

const words = (v) => (v ? { value: v, type: 'StringId' } : { value: '', type: 'Text' });

function widget(c) {
    if (c.kind === 'label') {
        return { type: 'label', widget: 'LT_ScrollLabel', focusable: 0, cells: { Text: words(c.text) } };
    }
    return {
        type: 'button', widget: 'LT_Button_MediaEntry_1Row', focusable: 3,
        cells: {
            PrimaryText: words(c.text), FrequencyText: words(''),
            FrequencyVisible: { value: c.kind !== 'button', type: 'Bool' }, IconVisible: { value: false, type: 'Bool' },
            ProgressVisible: { value: false, type: 'Bool' }, IsPlaying: { value: false, type: 'Bool' }
        }
    };
}

function xml(spec) {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>'];
    spec.states.forEach((s) => {
        out.push(`    <container id="${s.id}" type="state" widget="LT_State_Wide_List">`,
            `        <layoutGroup id="${100 + 2 * s.id}" name="Titlebar">`,
            `            <component id="${s.titleId}" type="title">`,
            '                <property id="2" value="1"/>',
            '            </component>',
            '        </layoutGroup>',
            `        <layoutGroup id="${101 + 2 * s.id}" name="List">`,
            '            <property id="3" value="1"/>');
        s.components.forEach((c) => {
            const w = widget(c);
            out.push(`            <component id="${c.id}" type="${w.type}" widget="${w.widget}">`,
                '                <property id="2" value="1"/>',
                `                <property id="3" value="${w.focusable}"/>`,
                '            </component>');
        });
        out.push('        </layoutGroup>', '    </container>');
    });
    out.push('</application>', '');
    return out.join('\n');
}

function uiDescription(spec) {
    const containers = {};
    spec.states.forEach((s) => {
        const components = {
            [s.titleId]: { type: 'title', name: `${s.name}_Title`,
                properties: { Visible: { value: 1, type: 'UInt' } }, rows: [{ Text: words(s.title) }] }
        };
        s.components.forEach((c) => {
            const w = widget(c);
            components[c.id] = { type: w.type, name: c.name,
                properties: { Visible: { value: 1, type: 'UInt' }, Focusable: { value: w.focusable, type: 'UInt' } },
                rows: [w.cells] };
        });
        containers[s.id] = { type: 'state', name: s.name, components };
    });
    return { schemaVersion: '1.3.0', containers };
}

function applicationJson(app, spec) {
    return { schemaVersion: '1.3.0', application: {
        uuid: spec.uuids.application, type: 'OnlineApp', name: app.id, vendor: 'owner', version: app.version,
        defaultLanguage: 'de_DE',
        uiDescriptions: [{ applicationFilePath: './uiDescriptions/ID8/application.xml',
            uiDescriptionFilePath: './uiDescriptions/ID8/uiDescription.json', hmi: ['ID8'] }],
        stringBundleUuid: spec.uuids.strings, resourceBundleUuid: spec.uuids.resources,
        variantGroups: [{ stringsPath: './variantGroups/Common/texts', resourcesPath: './variantGroups/Common/images',
            hmi: ['ID8'], brands: ['BMW'] }],
        entryPoints: [{ name: app.id, uuid: spec.uuids.entry, textId: spec.titleSid, icon: spec.icon,
            insertionStateId: 20974, insertionFocusId: 2, insertionMode: 'INSERT_BELOW', insertionOrder: 0,
            insertionPriority: 0, previewType: 'NONE', bookmarkable: true, private: null, appearance: 'DEFAULT',
            isGroupHeader: false, insertionGroup: 0 }]
    } };
}

function packageJson(app, spec) {
    return { name: app.id, version: app.version, description: spec.description, private: false,
        main: 'javascript/runner.js',
        oapAppSettings: { maxDiskUsage: spec.diskBytes || 10485760, cpuLimit: spec.cpuLimit || 20, memoryThresholdKB: spec.memoryKB || 65536,
            priority: 'PRIO_MEDIUM', visibility: 'FOREGROUND', latencyClass: 'FOREGROUND', loggingId: spec.loggingId,
            userLoginRequired: false, backgroundPriority: 150, someipManifest: 'manifest.json' },
        files: ['config', 'rhmiData', 'package.json', 'npm-shrinkwrap.json', 'permissions.json', 'javascript', 'manifest.json'],
        dependencies: { 'oap-sdk': '24.10.2' }, engines: { node: '>=8.7.0' }, author: 'owner',
        license: 'SEE LICENSE IN LICENSE', mguLocalOnly: true, mguHmi: ['ID8'],
        // spec.startType 'autostart': the head unit starts the app by itself and again when it stops (the Store's
        // deploy tool, package.json mguAppStartType); without it the app starts when its tile is pressed
        ...(spec.startType ? { mguAppStartType: spec.startType } : {}) };
}

function manifest(spec) {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'base-manifest.json'), 'utf8'));
    Object.assign(m.proxies, spec.proxies || {});
    return m;
}

/* The HMI's language files: the same German words in each, so every display language shows them. */
const LANGS = ['ar_AE', 'cs_CZ', 'da_DK', 'de_DE', 'el_GR', 'en_GB', 'en_US', 'es_ES', 'es_MX', 'fi_FI', 'fr_CA', 'fr_FR',
    'he_IL', 'hu_HU', 'id_ID', 'it_IT', 'ja_JP', 'ko_KR', 'nl_BE', 'nl_NL', 'no_NO', 'pl_PL', 'pt_BR', 'pt_PT', 'ro_RO',
    'ru_RU', 'sk_SK', 'sl_SI', 'sv_SE', 'th_TH', 'tr_TR', 'uk_UA', 'vi_VN', 'zh_CN', 'zh_TW', 'zh_yue_Hans_CN',
    'zh_yue_Hant_CN'];

const json = (o) => JSON.stringify(o, null, 2) + '\n';

function write(id) {
    const dir = path.join(APPS, id);
    const app = JSON.parse(fs.readFileSync(path.join(dir, 'mgu-app.json'), 'utf8'));
    const spec = require(path.join(dir, 'spec.js'));
    const pkg = path.join(dir, app.tree);
    const rhmi = path.join(pkg, 'rhmiData');
    const ui = path.join(rhmi, 'uiDescriptions', 'ID8');
    const texts = path.join(rhmi, 'variantGroups', 'Common', 'texts');
    [ui, texts, path.join(pkg, 'config')].forEach((d) => fs.mkdirSync(d, { recursive: true }));
    fs.writeFileSync(path.join(pkg, 'package.json'), json(packageJson(app, spec)));
    fs.writeFileSync(path.join(pkg, 'npm-shrinkwrap.json'),
        json({ name: app.id, version: app.version, lockfileVersion: 1, requires: true, dependencies: {} }));
    fs.writeFileSync(path.join(pkg, 'manifest.json'), json(manifest(spec)));
    fs.copyFileSync(path.join(__dirname, 'permissions.json'), path.join(pkg, 'permissions.json'));
    fs.writeFileSync(path.join(pkg, 'config', 'base.json'), '{}\n');
    fs.writeFileSync(path.join(rhmi, 'application.json'), json(applicationJson(app, spec)));
    fs.writeFileSync(path.join(ui, 'application.xml'), xml(spec));
    fs.writeFileSync(path.join(ui, 'uiDescription.json'), json(uiDescription(spec)));
    LANGS.forEach((l) => fs.writeFileSync(path.join(texts, `${l}.json`), json(spec.texts)));
    app.modules.forEach((m) => {
        const shared = path.join(REPO, 'shared', path.basename(m));
        if (m.indexOf('src/') === 0 && fs.existsSync(shared)) {
            fs.copyFileSync(shared, path.join(dir, m));
        }
    });
    return `${app.id} ${app.version}: ${spec.states.length} state(s)`;
}

if (require.main === module) {
    const ids = process.argv[2] ? [process.argv[2]] :
        fs.readdirSync(APPS).filter((d) => fs.existsSync(path.join(APPS, d, 'spec.js')));
    ids.forEach((id) => console.log(`wrote ${write(id)}`));
}

module.exports = { write };
