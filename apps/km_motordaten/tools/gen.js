'use strict';
/**
 * Writes the staged package tree (package/) from the tables below:
 * package.json, npm-shrinkwrap.json, rhmiData/application.json, the iDrive 8
 * UI (uiDescriptions/ID8) and the RHMI text files. Run after every change:
 *
 *   node tools/gen.js
 *
 * iDrive 8 widgets as the Store uses them: a LT_State_Wide_List state,
 * LT_ScrollLabel labels and LT_Button_MediaEntry_1Row rows (PrimaryText left,
 * FrequencyText right). No state has a ParentState (Hmi8 refuses nested parents).
 */
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, '..');
const APP = require(path.join(HERE, 'mgu-app.json'));
const PKG = path.join(HERE, APP.tree);
const RHMI = path.join(PKG, 'rhmiData');

const UUID = {
    application: 'da40fc2d-3f65-47c7-846b-4f8c438fe835',
    strings: 'a0ee1d78-27ba-4996-9355-df9bace162a4',
    resources: '1e3a9ac0-607b-4ad6-a2c1-6562b2965d03',
    entry: '3f2cb455-d92b-4ae5-8e24-fdd887f1a6d0'
};

/* Words shown by string id (the HMI looks them up in every language file). */
const TEXTS = {
    SID_TEMP_EMPTY: '',
    SID_MD_TITLE: 'Motordaten',
    SID_MD_RPM: 'Drehzahl',
    SID_MD_OIL: 'Öltemperatur',
    SID_MD_COOLANT: 'Kühlmitteltemperatur'
};

/* The one test screen. Rows: label left, value right (written at runtime). */
const STATES = [{
    id: 1, name: 'ST_OnlineApps_Motordaten', titleId: 10, title: 'SID_MD_TITLE',
    components: [
        { id: 20, kind: 'label', name: 'mdStatus', text: '' },
        { id: 21, kind: 'row', name: 'mdRpm', text: 'SID_MD_RPM' },
        { id: 22, kind: 'row', name: 'mdOil', text: 'SID_MD_OIL' },
        { id: 23, kind: 'row', name: 'mdCoolant', text: 'SID_MD_COOLANT' }
    ]
}];

const words = (v) => (v ? { value: v, type: 'StringId' } : { value: '', type: 'Text' });

function widget(c) {
    if (c.kind === 'label') {
        return { type: 'label', widget: 'LT_ScrollLabel', focusable: 0, cells: { Text: words(c.text) } };
    }
    return {
        type: 'button', widget: 'LT_Button_MediaEntry_1Row', focusable: 3,
        cells: {
            PrimaryText: words(c.text), FrequencyText: words(''),
            FrequencyVisible: { value: true, type: 'Bool' }, IconVisible: { value: false, type: 'Bool' },
            ProgressVisible: { value: false, type: 'Bool' }, IsPlaying: { value: false, type: 'Bool' }
        }
    };
}

function xml() {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>'];
    STATES.forEach((s) => {
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

function uiDescription() {
    const containers = {};
    STATES.forEach((s) => {
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

function applicationJson() {
    return { schemaVersion: '1.3.0', application: {
        uuid: UUID.application, type: 'OnlineApp', name: APP.id, vendor: 'owner', version: APP.version,
        defaultLanguage: 'de_DE',
        uiDescriptions: [{ applicationFilePath: './uiDescriptions/ID8/application.xml',
            uiDescriptionFilePath: './uiDescriptions/ID8/uiDescription.json', hmi: ['ID8'] }],
        stringBundleUuid: UUID.strings, resourceBundleUuid: UUID.resources,
        variantGroups: [{ stringsPath: './variantGroups/Common/texts', resourcesPath: './variantGroups/Common/images',
            hmi: ['ID8'], brands: ['BMW'] }],
        entryPoints: [{ name: APP.id, uuid: UUID.entry, textId: 'SID_MD_TITLE', icon: 'motordaten_icon.png',
            insertionStateId: 20974, insertionFocusId: 2, insertionMode: 'INSERT_BELOW', insertionOrder: 0,
            insertionPriority: 0, previewType: 'NONE', bookmarkable: true, private: null, appearance: 'DEFAULT',
            isGroupHeader: false, insertionGroup: 0 }]
    } };
}

function packageJson() {
    return { name: APP.id, version: APP.version, description: 'Motordaten: Drehzahl und Temperaturen', private: false,
        main: 'javascript/runner.js',
        oapAppSettings: { maxDiskUsage: 10485760, cpuLimit: 20, memoryThresholdKB: 65536, priority: 'PRIO_MEDIUM',
            visibility: 'FOREGROUND', latencyClass: 'FOREGROUND', loggingId: 'KMMD', userLoginRequired: false,
            backgroundPriority: 150, someipManifest: 'manifest.json' },
        files: ['config', 'rhmiData', 'package.json', 'npm-shrinkwrap.json', 'permissions.json', 'javascript', 'manifest.json'],
        dependencies: { 'oap-sdk': '24.10.2' }, engines: { node: '>=8.7.0' }, author: 'owner',
        license: 'GPL-3.0-or-later', mguLocalOnly: true, mguHmi: ['ID8'] };
}

/* The HMI's language files: the same German words in each, so every display language shows them. */
const LANGS = ['ar_AE', 'cs_CZ', 'da_DK', 'de_DE', 'el_GR', 'en_GB', 'en_US', 'es_ES', 'es_MX', 'fi_FI', 'fr_CA', 'fr_FR',
    'he_IL', 'hu_HU', 'id_ID', 'it_IT', 'ja_JP', 'ko_KR', 'nl_BE', 'nl_NL', 'no_NO', 'pl_PL', 'pt_BR', 'pt_PT', 'ro_RO',
    'ru_RU', 'sk_SK', 'sl_SI', 'sv_SE', 'th_TH', 'tr_TR', 'uk_UA', 'vi_VN', 'zh_CN', 'zh_TW', 'zh_yue_Hans_CN',
    'zh_yue_Hant_CN'];

const json = (o) => JSON.stringify(o, null, 2) + '\n';

function write() {
    const ui = path.join(RHMI, 'uiDescriptions', 'ID8');
    const texts = path.join(RHMI, 'variantGroups', 'Common', 'texts');
    [ui, texts].forEach((d) => fs.mkdirSync(d, { recursive: true }));
    fs.writeFileSync(path.join(PKG, 'package.json'), json(packageJson()));
    fs.writeFileSync(path.join(PKG, 'npm-shrinkwrap.json'),
        json({ name: APP.id, version: APP.version, lockfileVersion: 1, requires: true, dependencies: {} }));
    fs.writeFileSync(path.join(RHMI, 'application.json'), json(applicationJson()));
    fs.writeFileSync(path.join(ui, 'application.xml'), xml());
    fs.writeFileSync(path.join(ui, 'uiDescription.json'), json(uiDescription()));
    LANGS.forEach((l) => fs.writeFileSync(path.join(texts, `${l}.json`), json(TEXTS)));
}

if (require.main === module) {
    write();
    console.log(`wrote ${APP.id} ${APP.version}: ${STATES.length} state(s), ${LANGS.length} language files`);
}

module.exports = { STATES, TEXTS };
