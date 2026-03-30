import './style.css'

let characterDataArray = [null, null, null];
let commonLorebook = [];
let chatHistory = [];
// API Configuration stored in localStorage or defaults
let apiConfig = {
    endpoint: localStorage.getItem('apiEndpoint') || 'http://localhost:5001/v1/chat/completions',
    key: localStorage.getItem('apiKey') || 'none',
    model: localStorage.getItem('apiModel') || 'local-model',
    tokens: parseInt(localStorage.getItem('apiTokens')) || 1000
};

let userConfig = {
    name:        localStorage.getItem('userName')        || 'User',
    personality: localStorage.getItem('userPersonality') || '',
    description: localStorage.getItem('userPersona')     || '',  // 旧キー流用でバックコンパット
    scenario:    localStorage.getItem('userScenario')    || '',
    first_mes:   localStorage.getItem('userFirstMes')    || '',
    mes_example: localStorage.getItem('userMesExample')  || '',
    avatar:      localStorage.getItem('userAvatar')      || '',
    lorebook:    JSON.parse(localStorage.getItem('userLorebook') || '[]')
};
let editTarget = 'player'; // 'player' | 0 | 1 | 2

// ======== QUEST SYSTEM ========
let savedQuests = [];
let activeQuest = null; // null when no quest is running

function createEmptyQuest() {
    return {
        spec: "rp_engine_quest_v1",
        id: "quest_" + Date.now(),
        metadata: {
            name: "新しいクエスト",
            tags: [],
            author: "",
            recommended_party_size: 2
        },
        selection_text: "",
        prologue_overview: "",
        ai_instructions: [],
        background: "",
        events: [],
        additional_settings: [],
        hidden_truths: [],
        items_clues: [],
        introduction_dialogue: ""
    };
}

function loadQuests() {
    try {
        const data = localStorage.getItem('savedQuests');
        if (data) savedQuests = JSON.parse(data);
    } catch (e) {
        console.error('Failed to load quests:', e);
        savedQuests = [];
    }
    try {
        const aq = localStorage.getItem('activeQuest');
        if (aq) activeQuest = JSON.parse(aq);
    } catch (e) {
        console.error('Failed to load active quest:', e);
        activeQuest = null;
    }
}

function saveQuests() {
    localStorage.setItem('savedQuests', JSON.stringify(savedQuests));
}

function saveActiveQuest() {
    if (activeQuest) {
        localStorage.setItem('activeQuest', JSON.stringify(activeQuest));
    } else {
        localStorage.removeItem('activeQuest');
    }
}

function addQuest(quest) {
    savedQuests.push(quest);
    saveQuests();
}

function updateQuest(quest) {
    const idx = savedQuests.findIndex(q => q.id === quest.id);
    if (idx !== -1) {
        savedQuests[idx] = quest;
        saveQuests();
    }
}

function deleteQuest(questId) {
    savedQuests = savedQuests.filter(q => q.id !== questId);
    saveQuests();
}

function exportQuest(quest) {
    const exportObj = { spec: "rp_engine_quest_v1", quest_data: quest };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj, null, 2));
    const a = document.createElement('a');
    a.setAttribute("href", dataStr);
    a.setAttribute("download", (quest.metadata.name || "quest") + ".json");
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function importQuestFromFile(file, callback) {
    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const json = JSON.parse(event.target.result);
            let questData;
            if (json.spec === "rp_engine_quest_v1" && json.quest_data) {
                questData = json.quest_data;
            } else if (json.spec === "rp_engine_quest_v1" && json.metadata) {
                questData = json;
            } else {
                alert('認識できないクエストファイル形式です。');
                return;
            }
            // Assign a new ID to avoid collisions
            questData.id = "quest_" + Date.now();
            addQuest(questData);
            if (callback) callback(questData);
        } catch (err) {
            alert('JSONファイルの解析に失敗しました。');
        }
    };
    reader.readAsText(file);
}
// ======== END QUEST SYSTEM DATA ========

// Character/User Macro Replacement Utility
function applyMacros(text, charName = null) {
    if (!text) return '';
    let result = text;
    // Replace {{user}} with player name
    result = result.replace(/{{user}}/gi, userConfig.name);

    // Determine which character name to use for {{char}}
    // Priority: 1) explicitly passed charName, 2) sole party member, 3) leave unreplaced
    let targetCharName = charName;
    if (!targetCharName) {
        const members = getActivePartyMembers();
        if (members.length === 1) {
            targetCharName = members[0].name;
        }
        // If multiple members and no charName specified, don't replace {{char}}
        // to avoid substituting the wrong character's name
    }

    if (targetCharName) {
        result = result.replace(/{{char}}/gi, targetCharName);
    }
    return result;
}

async function init() {
    setupNavigation();
    setupSettings();
    setupPartySet();
    setupCharacterEdit();
    setupChat();
    loadQuests();
    setupQuestUI();
    setupQuestHUD();
    updateQuestHUD();
    
    try {
        const savedParty = localStorage.getItem('savedParty');
        if (savedParty) {
            characterDataArray = JSON.parse(savedParty);
        } else {
            // Backward compatibility loop or default slots
            for (let i = 0; i < 3; i++) {
                characterDataArray[i] = {
                    name: `Slot ${i+1} Empty`,
                    tags: ["Draft"],
                    personality: "Unknown",
                    description: "Character description goes here...",
                    scenario: "A new scenario...",
                    first_mes: i === 0 ? "Hello!" : "",
                    mes_example: "",
                    avatar: "",
                    lorebook: []
                };
            }
        }

        const savedCommonLore = localStorage.getItem('savedCommonLore');
        if (savedCommonLore) {
            commonLorebook = JSON.parse(savedCommonLore);
        }

        renderPartySheet();
        
        // Use party ID for chat history (getPartyId() と同じロジックを使用)
        const savedChat = localStorage.getItem('chatHistory_' + getPartyId());
        if (savedChat) {
            chatHistory = JSON.parse(savedChat);
            // Restore visual messages — splitAndAppendCharMessages を使い SPEAKER タグを正しく解析
            document.getElementById('chat-history').innerHTML = '';
            chatHistory.forEach((msg, idx) => {
                if (msg.role === 'user') {
                    appendMessage('user', msg.content, userConfig.name, false, idx);
                } else {
                    // assistant メッセージは SPEAKER タグ解析付きで復元
                    splitAndAppendCharMessages(msg.content, false, idx);
                }
            });
        } else {
            initializeChat(characterDataArray);
        }
        renderPartySetGrid();
        updateEditTabNames();
    } catch (error) {
        console.error('Core error in init():', error);
        const view = document.getElementById('character-view');
        if (view) view.innerHTML = '<div class="error">アプリの初期化に失敗しました。コンソールを確認してください。</div>';
    }
}

// ---- SPA Navigation ----
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(function(item) {
        item.addEventListener('click', function() {
            navItems.forEach(function(n) { n.classList.remove('active'); });
            item.classList.add('active');
            
            document.querySelectorAll('.view-section').forEach(function(v) { v.classList.add('hidden'); });
            
            const targetId = item.getAttribute('data-view');
            if (targetId) {
                document.getElementById(targetId).classList.remove('hidden');
                
                if(targetId === 'chat-view') {
                    scrollToBottom();
                }
            }
        });
    });

    // Reset Chat Button
    const resetBtn = document.getElementById('reset-chat-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', function() {
            let msg = '現在の会話履歴を削除して、最初からやり直しますか？';
            if (activeQuest) {
                msg += '\n\n※ アクティブなクエスト「' + activeQuest.template.metadata.name + '」も終了されます。';
            }
            if (confirm(msg)) {
                if (activeQuest) {
                    activeQuest = null;
                    saveActiveQuest();
                    updateQuestHUD();
                }
                localStorage.removeItem('chatHistory_' + getPartyId());
                initializeChat(characterDataArray);
                alert('会話をリセットしました。');
            }
        });
    }
}

// ---- Settings Logic ----
function setupSettings() {
    document.getElementById('api-url').value = apiConfig.endpoint;
    document.getElementById('api-key').value = apiConfig.key;
    document.getElementById('api-model').value = apiConfig.model;
    document.getElementById('api-tokens').value = apiConfig.tokens;
    
    document.getElementById('save-settings-btn').addEventListener('click', function() {
        apiConfig.endpoint = document.getElementById('api-url').value;
        apiConfig.key = document.getElementById('api-key').value;
        apiConfig.model = document.getElementById('api-model').value;
        apiConfig.tokens = parseInt(document.getElementById('api-tokens').value) || 1000;
        
        localStorage.setItem('apiEndpoint', apiConfig.endpoint);
        localStorage.setItem('apiKey', apiConfig.key);
        localStorage.setItem('apiModel', apiConfig.model);
        localStorage.setItem('apiTokens', apiConfig.tokens);
        
        alert('Settings saved successfully!');
    });
}

// ---- Editor Logic ----
// ======== SAVE HELPERS ========

function saveUserConfig() {
    localStorage.setItem('userName',        userConfig.name);
    localStorage.setItem('userPersonality', userConfig.personality);
    localStorage.setItem('userPersona',     userConfig.description);
    localStorage.setItem('userScenario',    userConfig.scenario    || '');
    localStorage.setItem('userFirstMes',    userConfig.first_mes   || '');
    localStorage.setItem('userMesExample',  userConfig.mes_example);
    if (userConfig.avatar) localStorage.setItem('userAvatar', userConfig.avatar);
    localStorage.setItem('userLorebook', JSON.stringify(userConfig.lorebook || []));
}

function getEditTargetData() {
    if (editTarget === 'player') return userConfig;
    return characterDataArray[editTarget] || null;
}

function setEditTargetData(data) {
    if (editTarget === 'player') {
        userConfig.name        = data.name        || 'User';
        userConfig.personality = data.personality || '';
        userConfig.description = data.description || '';
        userConfig.scenario    = data.scenario    || '';
        userConfig.first_mes   = data.first_mes   || '';
        userConfig.mes_example = data.mes_example || '';
        userConfig.avatar      = data.avatar      || userConfig.avatar || '';
        userConfig.lorebook    = data.lorebook    || [];
        saveUserConfig();
    } else {
        characterDataArray[editTarget] = data;
        localStorage.setItem('savedParty', JSON.stringify(characterDataArray));
    }
}

// ======== PARTY SET VIEW ========

function setupPartySet() {
    // Party Export
    document.getElementById('export-party-btn').addEventListener('click', function() {
        const exportObj = {
            spec: "rp_engine_party_v1",
            party: characterDataArray,
            common_lore: commonLorebook,
            user_config: userConfig
        };
        var blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'party_export_' + Date.now() + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    // Party Import
    document.getElementById('import-party-file').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const json = JSON.parse(event.target.result);
                if (json.spec === "rp_engine_party_v1") {
                    characterDataArray = json.party;
                    commonLorebook = json.common_lore || [];
                    if (json.user_config) {
                        userConfig.name        = json.user_config.name        || 'User';
                        userConfig.personality = json.user_config.personality || '';
                        userConfig.description = json.user_config.description || json.user_config.persona || '';
                        userConfig.scenario    = json.user_config.scenario    || '';
                        userConfig.first_mes   = json.user_config.first_mes   || '';
                        userConfig.mes_example = json.user_config.mes_example || '';
                        userConfig.avatar      = json.user_config.avatar      || '';
                        userConfig.lorebook    = json.user_config.lorebook    || [];
                        saveUserConfig();
                    }
                    localStorage.setItem('savedParty', JSON.stringify(characterDataArray));
                    localStorage.setItem('savedCommonLore', JSON.stringify(commonLorebook));
                    renderPartySheet();
                    renderPartySetGrid();
                    updateEditTabNames();
                    alert('Party imported!');
                } else {
                    alert('Invalid party export file.');
                }
            } catch(err) {
                alert('Failed to parse JSON file.');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    renderPartySetGrid();
}

function renderPartySetGrid() {
    const grid = document.getElementById('party-set-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Helper: build one slot card
    function buildCard(label, data, slotKey, isPlayer) {
        const card = document.createElement('div');
        card.className = 'party-set-card';

        const avatarPlaceholder = isPlayer
            ? "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23aaa' d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>"
            : "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23666' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z'/></svg>";

        const avatarSrc = (data && data.avatar) ? data.avatar : avatarPlaceholder;
        const name = (data && data.name) ? data.name : (isPlayer ? 'User' : '(空)');
        const personality = (data && data.personality) ? data.personality : '';
        const isEmpty = !data || !data.name || data.name.includes('Empty');

        card.innerHTML = `
            <div class="psc-label">${label}</div>
            <img class="psc-avatar" src="${avatarSrc}" alt="${escapeHTML(name)}">
            <div class="psc-name">${escapeHTML(name)}</div>
            <div class="psc-personality">${escapeHTML(personality).substring(0, 40)}</div>
            <div class="psc-actions">
                <label class="secondary-btn psc-btn">Import<input type="file" accept=".json" class="psc-import-file" data-slot="${slotKey}" hidden></label>
                <button class="primary-btn psc-btn psc-edit-btn" data-slot="${slotKey}">Edit</button>
                ${!isPlayer ? '<button class="danger-btn psc-btn psc-clear-btn" data-slot="' + slotKey + '">Clear</button>' : ''}
            </div>
        `;
        return card;
    }

    // Player card
    grid.appendChild(buildCard('Player ({{user}})', userConfig, 'player', true));
    // NPC slot cards
    for (let i = 0; i < 3; i++) {
        grid.appendChild(buildCard('Slot ' + (i+1), characterDataArray[i], String(i), false));
    }

    // Wire import file inputs
    grid.querySelectorAll('.psc-import-file').forEach(input => {
        input.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            const slotKey = this.getAttribute('data-slot');
            const reader = new FileReader();
            reader.onload = function(event) {
                try {
                    const json = JSON.parse(event.target.result);
                    const d = normalizeToEngineChar(json);
                    if (!d || !d.name) { alert('認識できないファイル形式です。'); return; }
                    if (slotKey === 'player') {
                        editTarget = 'player';
                        setEditTargetData(d);
                    } else {
                        editTarget = parseInt(slotKey);
                        setEditTargetData(d);
                    }
                    renderPartySheet();
                    renderPartySetGrid();
                    updateEditTabNames();
                    alert(d.name + ' をセットしました！');
                } catch(err) { alert('JSONの読み込みに失敗しました。'); }
            };
            reader.readAsText(file);
            e.target.value = '';
        });
    });

    // Wire Edit buttons → switch to Character Edit view + select tab
    grid.querySelectorAll('.psc-edit-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const slotKey = this.getAttribute('data-slot');
            editTarget = (slotKey === 'player') ? 'player' : parseInt(slotKey);
            // Switch nav to char-edit-view
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.querySelectorAll('.view-section').forEach(v => v.classList.add('hidden'));
            const editNav = document.querySelector('[data-view="char-edit-view"]');
            if (editNav) editNav.classList.add('active');
            document.getElementById('char-edit-view').classList.remove('hidden');
            // Select the correct tab
            document.querySelectorAll('#edit-tabs .slot-tab').forEach(t => t.classList.remove('active'));
            const targetTab = document.querySelector('#edit-tabs .slot-tab[data-edit-target="' + slotKey + '"]');
            if (targetTab) targetTab.classList.add('active');
            loadEditTargetIntoEditor();
        });
    });

    // Wire Clear buttons
    grid.querySelectorAll('.psc-clear-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.getAttribute('data-slot'));
            if (!confirm('Slot ' + (idx+1) + ' のデータをクリアしますか？')) return;
            characterDataArray[idx] = {
                name: 'Slot ' + (idx+1) + ' Empty', tags: ["Draft"], personality: "Unknown",
                description: "", scenario: "", first_mes: "", mes_example: "", avatar: "", lorebook: []
            };
            localStorage.setItem('savedParty', JSON.stringify(characterDataArray));
            renderPartySheet();
            renderPartySetGrid();
            updateEditTabNames();
        });
    });
}

/**
 * あらゆるフォーマットのキャラクターカードを RP Engine 内部フォーマットに正規化する。
 * 対応フォーマット:
 *   rp_engine_card_v1  — 新統一フォーマット
 *   rp_engine_v1       — 旧エンジンキャラフォーマット
 *   rp_engine_user_v1  — 旧ユーザーペルソナフォーマット
 *   chara_card_v2      — SillyTavern 互換
 *   フォールバック     — engine_data / data / root
 * @returns {object} エンジン内部フォーマットのキャラクターオブジェクト
 */
function normalizeToEngineChar(json) {
    if (!json || typeof json !== 'object') return null;

    // 新統一フォーマット
    if (json.spec === 'rp_engine_card_v1') {
        return json.data || {};
    }

    // 旧エンジンキャラフォーマット
    if (json.spec === 'rp_engine_v1') {
        return json.engine_data || {};
    }

    // 旧ユーザーペルソナフォーマット → キャラフォーマットに変換
    if (json.spec === 'rp_engine_user_v1') {
        const u = json.user_data || {};
        return {
            name:        u.name        || '',
            personality: u.personality || '',
            description: u.description || '',
            scenario:    '',
            first_mes:   '',
            mes_example: u.mes_example || '',
            avatar:      u.avatar      || '',
            tags:        [],
            creator:     '',
            lorebook:    []
        };
    }

    // SillyTavern chara_card_v2 フォーマット
    if (json.spec === 'chara_card_v2' || json.data) {
        const raw = json.data || {};
        const d = {
            name:        raw.name        || '',
            personality: raw.personality || '',
            description: raw.description || '',
            scenario:    raw.scenario    || '',
            first_mes:   raw.first_mes   || '',
            mes_example: raw.mes_example || '',
            avatar:      raw.avatar      || '',
            tags:        raw.tags        || [],
            creator:     raw.creator     || '',
            lorebook:    []
        };
        // character_book.entries → lorebook 変換
        if (raw.character_book && Array.isArray(raw.character_book.entries)) {
            d.lorebook = raw.character_book.entries
                .filter(e => e.enabled !== false && (e.content || '').trim())
                .map(e => ({
                    key:     (e.keys || []).join(', '),
                    content: e.content || ''
                }))
                .filter(e => e.content);
        }
        return d;
    }

    // フォールバック: engine_data / data / root をそのまま使用
    return json.engine_data || json.data || json;
}

// ======== CHARACTER EDIT VIEW (統一エディタ) ========

function setupCharacterEdit() {
    // Tab switching: Player / Slot 1-3
    const tabs = document.querySelectorAll('#edit-tabs .slot-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', function() {
            document.querySelectorAll('#edit-tabs .slot-tab').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            const target = this.getAttribute('data-edit-target');
            editTarget = (target === 'player') ? 'player' : parseInt(target);
            loadEditTargetIntoEditor();
        });
    });

    // Avatar upload
    document.getElementById('edit-char-avatar').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(event) {
            const data = getEditTargetData();
            if (data) {
                data.avatar = event.target.result;
                // Update preview
                const previewDiv = document.getElementById('slot-avatar-preview');
                if (previewDiv) previewDiv.innerHTML = '<img src="' + event.target.result + '" class="slot-preview-img">';
            }
        };
        reader.readAsDataURL(file);
    });

    // Save
    document.getElementById('save-char-btn').addEventListener('click', function() {
        const formData = {
            name:        document.getElementById('edit-char-name').value.trim() || (editTarget === 'player' ? 'User' : ''),
            personality: document.getElementById('edit-char-personality').value,
            description: document.getElementById('edit-char-desc').value,
            scenario:    document.getElementById('edit-char-scenario').value,
            first_mes:   document.getElementById('edit-char-firstmes').value,
            mes_example: document.getElementById('edit-char-examples').value,
            lorebook:    getLorebookFromEditor(),
            avatar:      (getEditTargetData() || {}).avatar || ''
        };
        setEditTargetData(formData);
        renderPartySheet();
        renderPartySetGrid();
        updateEditTabNames();
        const label = (editTarget === 'player') ? 'Player' : 'Slot ' + (editTarget + 1);
        alert(label + ' を保存しました！');
    });

    // Export JSON — rp_engine_card_v1
    document.getElementById('export-char-btn').addEventListener('click', function() {
        const data = getEditTargetData();
        if (!data) return;
        var exportObj = {
            spec: 'rp_engine_card_v1',
            spec_version: '1.0',
            data: {
                name:        data.name        || '',
                personality: data.personality || '',
                description: data.description || '',
                scenario:    data.scenario    || '',
                first_mes:   data.first_mes   || '',
                mes_example: data.mes_example || '',
                avatar:      data.avatar      || '',
                tags:        data.tags        || [],
                creator:     data.creator     || '',
                lorebook:    data.lorebook    || []
            }
        };
        var blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (data.name || 'character') + '_card.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    // Import JSON
    document.getElementById('import-char-file').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(event) {
            try {
                var json = JSON.parse(event.target.result);
                var d = normalizeToEngineChar(json);
                if (!d) { alert('認識できないファイル形式です。'); return; }
                setEditTargetData(d);
                loadEditTargetIntoEditor();
                renderPartySheet();
                renderPartySetGrid();
                updateEditTabNames();
                const label = (editTarget === 'player') ? 'Player' : 'Slot ' + (editTarget + 1);
                alert((d.name || '?') + ' を ' + label + ' にインポートしました！');
            } catch(err) { alert('JSONの読み込みに失敗しました。'); }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // Add Lorebook entry
    document.getElementById('add-lore-btn').addEventListener('click', function() {
        const data = getEditTargetData();
        if (!data) return;
        if (!data.lorebook) data.lorebook = [];
        data.lorebook.push({ key: '', content: '' });
        renderLorebookEditor();
    });

    // Clear this slot (NPC only)
    document.getElementById('clear-slot-btn').addEventListener('click', function() {
        if (editTarget === 'player') {
            alert('Player はクリアできません。');
            return;
        }
        const idx = editTarget;
        if (!confirm('Slot ' + (idx + 1) + ' のデータをクリアしますか？')) return;
        characterDataArray[idx] = {
            name: 'Slot ' + (idx + 1) + ' Empty', tags: ["Draft"], personality: "Unknown",
            description: "", scenario: "", first_mes: "", mes_example: "", avatar: "", lorebook: []
        };
        localStorage.setItem('savedParty', JSON.stringify(characterDataArray));
        loadEditTargetIntoEditor();
        renderPartySheet();
        renderPartySetGrid();
        updateEditTabNames();
    });

    // Common Lorebook (World Lore view)
    const addCommonLoreBtn = document.getElementById('add-common-lore-btn');
    if (addCommonLoreBtn) {
        addCommonLoreBtn.addEventListener('click', function() {
            commonLorebook.push({ key: '', content: '' });
            renderCommonLorebookEditor();
        });
    }
    const saveCommonLoreBtn = document.getElementById('save-common-lore-btn');
    if (saveCommonLoreBtn) {
        saveCommonLoreBtn.addEventListener('click', function() {
            commonLorebook = getCommonLorebookFromEditor();
            localStorage.setItem('savedCommonLore', JSON.stringify(commonLorebook));
            alert('Global Lorebook saved!');
        });
    }

    // Initial load
    loadEditTargetIntoEditor();
}

function loadEditTargetIntoEditor() {
    const data = getEditTargetData();
    const empty = { name: '', personality: '', description: '', scenario: '', first_mes: '', mes_example: '', lorebook: [], avatar: '' };
    const char = data || empty;

    document.getElementById('edit-char-name').value        = char.name        || '';
    document.getElementById('edit-char-personality').value = char.personality || '';
    document.getElementById('edit-char-desc').value        = char.description || '';
    document.getElementById('edit-char-scenario').value    = char.scenario    || '';
    document.getElementById('edit-char-firstmes').value    = char.first_mes   || '';
    document.getElementById('edit-char-examples').value    = char.mes_example || '';

    // Avatar preview
    const previewDiv = document.getElementById('slot-avatar-preview');
    if (previewDiv) {
        if (char.avatar) {
            previewDiv.innerHTML = '<img src="' + char.avatar + '" alt="' + escapeHTML(char.name || '') + '" class="slot-preview-img">';
        } else {
            previewDiv.innerHTML = '<div class="slot-preview-empty">アイコン未設定</div>';
        }
    }

    // Clear button visibility (hide for Player)
    const clearBtn = document.getElementById('clear-slot-btn');
    if (clearBtn) clearBtn.style.display = (editTarget === 'player') ? 'none' : '';

    renderLorebookEditor();
    renderCommonLorebookEditor();
}

function updateEditTabNames() {
    document.querySelectorAll('#edit-tabs .slot-tab').forEach(tab => {
        const target = tab.getAttribute('data-edit-target');
        if (target === 'player') {
            const name = userConfig.name || 'Player';
            tab.textContent = name.substring(0, 12);
        } else {
            const idx = parseInt(target);
            const char = characterDataArray[idx];
            if (char && char.name && !char.name.includes('Empty')) {
                tab.textContent = char.name.substring(0, 12);
            } else {
                tab.textContent = 'Slot ' + (idx + 1);
            }
        }
    });
}

function renderLorebookEditor() {
    const container = document.getElementById('lorebook-entries');
    if (!container) return;
    container.innerHTML = '';

    const data = getEditTargetData();
    if (!data) return;

    const lore = data.lorebook || [];
    lore.forEach((entry, index) => {
        const div = document.createElement('div');
        div.className = 'lore-entry';
        div.innerHTML = `
            <div class="lore-entry-header">
                <input type="text" placeholder="Keyword (e.g. 剣, 魔法, 場所名)" class="lore-key" value="${escapeHTML(entry.key || '')}">
                <button class="remove-lore-btn" onclick="removeLoreEntry(${index})">Remove</button>
            </div>
            <textarea placeholder="AIに教えたい情報" class="lore-content">${escapeHTML(entry.content || '')}</textarea>
        `;
        container.appendChild(div);
    });
}

window.removeLoreEntry = function(index) {
    const data = getEditTargetData();
    if (data && data.lorebook) {
        data.lorebook.splice(index, 1);
        renderLorebookEditor();
    }
};

function renderCommonLorebookEditor() {
    const container = document.getElementById('common-lorebook-entries');
    if (!container) return;
    container.innerHTML = '';
    
    commonLorebook.forEach((entry, index) => {
        const div = document.createElement('div');
        div.className = 'lore-entry';
        div.innerHTML = `
            <div class="lore-entry-header">
                <input type="text" placeholder="Keyword (全キャラ共通取得)" class="lore-key" value="${escapeHTML(entry.key || '')}">
                <button class="remove-lore-btn" onclick="removeCommonLoreEntry(${index})">Remove</button>
            </div>
            <textarea placeholder="世界観や共有ルールなど" class="lore-content">${escapeHTML(entry.content || '')}</textarea>
        `;
        container.appendChild(div);
    });
}

// Global scope helper for the onclick above
window.removeCommonLoreEntry = function(index) {
    commonLorebook.splice(index, 1);
    renderCommonLorebookEditor();
};

function getLorebookFromEditor() {
    const list = [];
    const entries = document.querySelectorAll('#lorebook-entries .lore-entry');
    entries.forEach(el => {
        const key = el.querySelector('.lore-key').value.trim();
        const content = el.querySelector('.lore-content').value.trim();
        if (key && content) {
            list.push({ key, content });
        }
    });
    return list;
}    

function getCommonLorebookFromEditor() {
    const list = [];
    const entries = document.querySelectorAll('#common-lorebook-entries .lore-entry');
    entries.forEach(el => {
        const key = el.querySelector('.lore-key').value.trim();
        const content = el.querySelector('.lore-content').value.trim();
        if (key && content) {
            list.push({ key, content });
        }
    });
    return list;
}    

// ---- Character View Rendering (Party) ----
function renderPartySheet() {
    var container = document.getElementById('party-sheet-grid');
    if (!container) return;
    
    const members = getActivePartyMembers();
    if (members.length === 0) {
        container.innerHTML = '<div class="loading">キャラクターが登録されていません。Party Setup からキャラクターをインポートしてください。</div>';
        return;
    }
    
    var html = '';
    members.forEach(function(char) {
        html += renderSingleCharacterCard(char);
    });
    container.innerHTML = html;
}

function renderSingleCharacterCard(char) {
    if (!char) return '';
    
    var tagsHtml = '';
    if (char.tags && Array.isArray(char.tags)) {
        tagsHtml = char.tags.map(function(tag) {
            return '<span class="badge">' + escapeHTML(tag) + '</span>';
        }).join('');
    }
    
    var personalityHtml = '';
    if (char.personality) {
        personalityHtml = char.personality.split(',').map(function(p) {
            return '<span class="p-tag">' + escapeHTML(p.trim()) + '</span>';
        }).join('');
    }
    
    var mesExampleHtml = '';
    if (char.mes_example) {
        mesExampleHtml = char.mes_example.split('<START>').filter(function(m) {
            return m.trim();
        }).map(function(m) {
            return '<div class="message-item">' + applyMacros(escapeHTML(m.trim()), char.name).replace(/\n/g, '<br>') + '</div>';
        }).join('');
    }
    
    var portraitSrc = char.avatar || '/placeholder.png';
    
    var html = '';
    html += '<div class="character-sheet">';
    html += '  <div class="character-header">';
    html += '    <img src="' + portraitSrc + '" alt="' + escapeHTML(char.name || '') + '" class="character-portrait">';
    html += '    <div class="character-info">';
    html += '      <h1>' + applyMacros(escapeHTML(char.name || 'No Name'), char.name) + '</h1>';
    html += '      <div class="character-badges">' + tagsHtml + '</div>';
    html += '    </div>';
    html += '  </div>';
    if (personalityHtml) {
        html += '  <div class="section">';
        html += '    <div class="section-title">Personality</div>';
        html += '    <div class="personality-tags">' + personalityHtml + '</div>';
        html += '  </div>';
    }
    if (char.description) {
        html += '  <div class="section">';
        html += '    <div class="section-title">Description</div>';
        html += '    <div class="section-content">' + applyMacros(escapeHTML(char.description), char.name) + '</div>';
        html += '  </div>';
    }
    if (char.scenario) {
        html += '  <div class="section">';
        html += '    <div class="section-title">Scenario</div>';
        html += '    <div class="section-content">' + applyMacros(escapeHTML(char.scenario), char.name) + '</div>';
        html += '  </div>';
    }
    if (char.first_mes) {
        html += '  <div class="section">';
        html += '    <div class="section-title">First Message</div>';
        html += '    <div class="message-item">' + applyMacros(escapeHTML(char.first_mes), char.name) + '</div>';
        html += '  </div>';
    }
    if (mesExampleHtml) {
        html += '  <div class="section">';
        html += '    <div class="section-title">Message Examples</div>';
        html += '    <div class="message-list">' + mesExampleHtml + '</div>';
        html += '  </div>';
    }
    // Show Lore count
    if (char.lorebook && char.lorebook.length > 0) {
        html += '  <div class="section">';
        html += '    <div class="section-title">📖 Lorebook</div>';
        html += '    <div class="section-content">' + char.lorebook.length + ' 件の世界観設定が登録されています。</div>';
        html += '  </div>';
    }
    html += '</div>';
    return html;
}

// ---- Chat Terminal Logic ----
function getPartyId() {
    return Array.from(characterDataArray).map(c => c ? (c.name || 'empty') : 'empty').join('-');
}

function getActivePartyMembers() {
    return characterDataArray.filter(c => c && c.name && !c.name.includes("Empty"));
}

// Multi-strategy speaker matching: handles katakana name, English alias, partial match
function findMemberBySpeaker(speakerTag, members) {
    if (!speakerTag || !members || members.length === 0) return null;
    const tag = speakerTag.trim().toLowerCase();

    // Strategy 1: Direct name match (substring in either direction)
    let found = members.find(m =>
        tag.includes(m.name.toLowerCase()) ||
        m.name.toLowerCase().includes(tag)
    );
    if (found) return found;

    // Strategy 2: Check if the speaker tag matches an alias/English name in the description
    // e.g., description contains "(Flandre Scarlet)" and AI outputs [SPEAKER: Flandre]
    found = members.find(m => {
        if (!m.description) return false;
        const desc = m.description.toLowerCase();
        // Check if the AI's speaker name appears in the character's description
        return desc.includes(tag);
    });
    if (found) return found;

    // Strategy 3: Check if any word in the speaker tag matches any word in the character name
    // e.g., "フランドール" matches "フランドール・スカーレット"
    const tagWords = tag.split(/[\s・\-_]+/).filter(w => w.length >= 2);
    found = members.find(m => {
        const nameWords = m.name.toLowerCase().split(/[\s・\-_]+/).filter(w => w.length >= 2);
        return tagWords.some(tw => nameWords.some(nw => nw.includes(tw) || tw.includes(nw)));
    });
    if (found) return found;

    return null;
}

function initializeChat(charArray) {
    if (!charArray) return;
    chatHistory = [];
    document.getElementById('chat-history').innerHTML = '';
    
    const members = getActivePartyMembers();
    const firstMember = members.length > 0 ? members[0] : null;

    if (firstMember && firstMember.first_mes) {
        appendMessage('char', applyMacros(firstMember.first_mes, firstMember.name), firstMember.name, true);
        saveChatHistory();
    }
}

function saveChatHistory() {
    localStorage.setItem('chatHistory_' + getPartyId(), JSON.stringify(chatHistory));
}

function appendMessage(role, text, name, shouldSave = true, forcedIndex = -1) {
    if (!name && role === 'user') {
        name = userConfig.name;
    } else if (!name) {
        name = 'System';
    }
    
    let msgIndex = forcedIndex;
    if (shouldSave) {
        const apiRole = role === 'char' ? 'assistant' : 'user';
        chatHistory.push({ role: apiRole, content: text });
        saveChatHistory();
        msgIndex = chatHistory.length - 1;
    } else if (forcedIndex === -1) {
        // If not saving and no forced index, we might just be showing a temporary message or 
        // we're in a middle of a process. For history rendering, forcedIndex should be provided.
        msgIndex = chatHistory.length - 1; 
    }
    var chatContainer = document.getElementById('chat-history');
    var msgDiv = document.createElement('div');
    // ナレーションの場合は専用CSSクラスを追加
    const isNarrator = (role === 'char' && (name === 'ナレーション' || name === 'Narrator'));
    msgDiv.className = 'chat-msg ' + role + (isNarrator ? ' narrator' : '');
    msgDiv.setAttribute('data-index', msgIndex);
    
    var userSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23aaa' d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>";
    // ナレーション用アイコン（本のアイコン）
    var narratorSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23c0a0ff' d='M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z'/></svg>";
    // 汎用プレースホルダー（不明キャラ用、シルエット）
    var unknownCharSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23666' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z'/></svg>";

    let portraitSrc = role === 'char' ? unknownCharSvg : (userConfig.avatar ? userConfig.avatar : userSvg);
    if (role === 'char') {
         // 「ナレーション」は専用アイコン
         if (name === 'ナレーション' || name === 'Narrator' || name === 'System') {
             portraitSrc = narratorSvg;
         } else {
             const members = getActivePartyMembers();
             const speaker = findMemberBySpeaker(name, members);
             if (speaker && speaker.avatar) {
                 portraitSrc = speaker.avatar;
             }
             // unknownCharSvg のまま（フランドールのplaceholder.pngを使わない）
         }
    }
    
    var avatarImg = document.createElement('img');
    avatarImg.src = portraitSrc;
    avatarImg.alt = name;
    avatarImg.className = 'msg-avatar';
    
    var contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    
    // Message Controls (Edit/Delete)
    if (role !== 'system') {
        const controls = document.createElement('div');
        controls.className = 'msg-controls';
        controls.innerHTML = `
            <button class="msg-control-btn edit-btn" title="Edit">🖊</button>
            <button class="msg-control-btn delete-btn" title="Delete">🗑</button>
        `;
        msgDiv.appendChild(controls);
        
        controls.querySelector('.edit-btn').addEventListener('click', () => editMessage(msgDiv, msgIndex));
        // charメッセージの場合はキャラ名も渡し、そのキャラのセグメントだけ削除できるようにする
        const speakerName = (role === 'char') ? name : null;
        controls.querySelector('.delete-btn').addEventListener('click', () => deleteMessage(msgIndex, speakerName));
    }

    // Add speaker name header for char messages
    if (role === 'char' && name && name !== 'System') {
        var nameTag = document.createElement('div');
        nameTag.className = 'msg-speaker-name';
        nameTag.textContent = name;
        contentDiv.appendChild(nameTag);
    }
    
    var textNode = document.createElement('div');
    textNode.className = 'msg-text';
    textNode.innerHTML = escapeHTML(text);
    contentDiv.appendChild(textNode);
    
    msgDiv.appendChild(avatarImg);
    msgDiv.appendChild(contentDiv);
    
    chatContainer.appendChild(msgDiv);
    scrollToBottom();
}

function editMessage(msgDiv, index) {
    if (index < 0) return;
    const textNode = msgDiv.querySelector('.msg-text');
    const originalText = chatHistory[index].content;
    
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-msg-textarea';
    textarea.value = originalText;
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary-btn small-btn';
    saveBtn.textContent = 'Save';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary-btn small-btn';
    cancelBtn.textContent = 'Cancel';
    
    const originalContent = textNode.innerHTML;
    textNode.innerHTML = '';
    textNode.appendChild(textarea);
    textNode.appendChild(saveBtn);
    textNode.appendChild(cancelBtn);
    
    saveBtn.onclick = () => {
        const newText = textarea.value;
        chatHistory[index].content = newText;
        saveChatHistory();
        // Full re-render is safest for visual consistency
        renderChatFromHistory();
    };
    
    cancelBtn.onclick = () => {
        textNode.innerHTML = originalContent;
    };
}

function deleteMessage(index, charName = null) {
    if (index < 0) return;
    const entry = chatHistory[index];
    if (!entry) return;

    // charNameが指定されており、assistantメッセージにSPEAKERタグが含まれる場合は
    // そのキャラのセグメントだけ削除し、残りのセグメントは保持する
    if (charName && entry.role === 'assistant') {
        const tagRegex = /\[SPEAKER:\s*([^\]]+)\]/gi;
        if (tagRegex.test(entry.content)) {
            // セグメント単位で分解し、該当キャラのセグメントを除外する
            tagRegex.lastIndex = 0;
            const segments = [];
            let match;
            let lastIdx = 0;
            while ((match = tagRegex.exec(entry.content)) !== null) {
                if (segments.length > 0) {
                    segments[segments.length - 1].content = entry.content.substring(lastIdx, match.index).trim();
                }
                segments.push({ speaker: match[1].trim(), content: '' });
                lastIdx = tagRegex.lastIndex;
            }
            if (segments.length > 0) {
                segments[segments.length - 1].content = entry.content.substring(lastIdx).trim();
            }

            // 削除対象キャラのセグメントを除いた残りを再結合
            const remaining = segments.filter(seg => {
                const m = findMemberBySpeaker(seg.speaker, getActivePartyMembers());
                const resolvedName = m ? m.name : seg.speaker;
                return resolvedName !== charName;
            });

            if (remaining.length === 0) {
                // 全セグメントが消えるなら確認してエントリごと削除
                if (!confirm(`${charName} の発言を削除すると、このターンの発言がすべて消えます。削除しますか？`)) return;
                chatHistory.splice(index, 1);
            } else {
                if (!confirm(`${charName} の発言を削除しますか？`)) return;
                // 残りのセグメントで内容を更新
                entry.content = remaining.map(seg => `[SPEAKER: ${seg.speaker}]\n${seg.content}`).join('\n');
            }
            saveChatHistory();
            renderChatFromHistory();
            return;
        }
    }

    // その他（userメッセージ / SPEAKERタグなしのassistantメッセージ）はターンごと削除
    const confirmMsg = (entry.role === 'assistant' && charName)
        ? `${charName} のターンをまとめて削除しますか？`
        : 'このメッセージを削除しますか？';
    if (confirm(confirmMsg)) {
        chatHistory.splice(index, 1);
        saveChatHistory();
        renderChatFromHistory();
    }
}

function renderChatFromHistory() {
    const container = document.getElementById('chat-history');
    container.innerHTML = '';
    
    chatHistory.forEach((msg, idx) => {
        if (msg.role === 'assistant') {
            splitAndAppendCharMessages(msg.content, false, idx);
        } else {
            appendMessage('user', msg.content, userConfig.name, false, idx);
        }
    });
}

// Split AI reply into per-character messages
function splitAndAppendCharMessages(fullReply, shouldSave, forcedIndex = -1) {
    const members = getActivePartyMembers();
    if (members.length === 0) return;
    
    if (members.length === 1) {
        // Single character, show as one bubble
        const name = members[0].name;
        appendMessage('char', applyMacros(fullReply, name), name, shouldSave, forcedIndex);
        return;
    }
    
    // Build a regex to find [SPEAKER: Name] or similar variations
    const tagRegex = /\[SPEAKER:\s*([^\]]+)\]/gi;

    // Let's check if the AI used the tags. If not, fallback to name prefix logic
    if (!tagRegex.test(fullReply)) {
        // Fallback: detect speaker changes using multiple common AI output patterns
        // Patterns: "Name:", "Name：", "**Name:**", "**Name：**", "【Name】", "Name「"
        const namePatterns = members.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const nameGroup = namePatterns.join('|');
        // Match line-start speaker patterns:
        //   Name: / Name：
        //   **Name:** / **Name：**
        //   【Name】
        //   ―Name― / —Name—
        //   Name「 (Japanese dialogue opener)
        const fallbackRegex = new RegExp(
            '(?=(?:^|\\n)\\s*(?:'
            + '\\*\\*(?:' + nameGroup + ')\\**\\s*[：:]\\s*\\**'  // **Name:** or **Name：**
            + '|【(?:' + nameGroup + ')】'                         // 【Name】
            + '|[―—](?:' + nameGroup + ')[―—]'                    // ―Name― / —Name—
            + '|(?:' + nameGroup + ')\\s*[：:]'                    // Name: / Name：
            + '|(?:' + nameGroup + ')「'                           // Name「
            + '))', 'g');
        const segments = fullReply.split(fallbackRegex).filter(s => s.trim());

        let mIndex = forcedIndex;
        if (shouldSave) {
            chatHistory.push({ role: 'assistant', content: fullReply });
            saveChatHistory();
            mIndex = chatHistory.length - 1;
        }

        segments.forEach(seg => {
            let trimmed = seg.trim();
            let speakerName = members[0].name;
            for (const m of members) {
                const esc = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Try all speaker prefix patterns and strip them from displayed text
                const prefixPatterns = [
                    new RegExp('^\\*\\*' + esc + '\\**\\s*[：:]\\s*\\**\\s*', ''),  // **Name:**
                    new RegExp('^【' + esc + '】\\s*', ''),                          // 【Name】
                    new RegExp('^[―—]' + esc + '[―—]\\s*', ''),                      // ―Name―
                    new RegExp('^' + esc + '\\s*[：:]\\s*', ''),                      // Name: / Name：
                    new RegExp('^' + esc + '(?=「)', ''),                             // Name「 (keep 「)
                ];
                let matched = false;
                for (const pRegex of prefixPatterns) {
                    if (pRegex.test(trimmed)) {
                        speakerName = m.name;
                        trimmed = trimmed.replace(pRegex, '');
                        matched = true;
                        break;
                    }
                }
                if (matched) break;
            }
            if (trimmed) {
                appendMessage('char', applyMacros(trimmed, speakerName), speakerName, false, mIndex);
            }
        });
        return;
    }

    // Tag-based Splitting (AI followed instructions)
    tagRegex.lastIndex = 0; // reset
    const segments = [];
    let match;
    let lastIndex = 0;

    while ((match = tagRegex.exec(fullReply)) !== null) {
        if (segments.length === 0 && match.index > 0) {
            // 最初の[SPEAKER:]タグの前にテキストがある場合 → ナレーションとして扱う
            const preText = fullReply.substring(0, match.index).trim();
            if (preText) {
                segments.push({ speaker: 'ナレーション', content: preText });
            }
        } else if (segments.length > 0) {
            segments[segments.length - 1].content = fullReply.substring(lastIndex, match.index).trim();
        }
        segments.push({ speaker: match[1].trim(), content: '' });
        lastIndex = tagRegex.lastIndex;
    }
    if (segments.length > 0) {
        segments[segments.length - 1].content = fullReply.substring(lastIndex).trim();
    }

    let msgIndex = forcedIndex;
    if (shouldSave) {
        chatHistory.push({ role: 'assistant', content: fullReply });
        saveChatHistory();
        msgIndex = chatHistory.length - 1;
    }

    segments.forEach(seg => {
        // Strip [SPEAKER: ...] tags from displayed content
        let cleanContent = seg.content.replace(/\[SPEAKER:\s*[^\]]+\]/gi, '').trim();
        if (!cleanContent) return;

        // 安全装置: AIが{{user}}の発言を生成した場合はスキップする
        const speakerLower = seg.speaker.trim().toLowerCase();
        if (speakerLower === userConfig.name.toLowerCase()) {
            console.warn('[RP Engine] AIが{{user}}の発言を生成したため除去しました:', seg.speaker);
            return; // ユーザーの発言はスキップ
        }

        // Find actual member by speaker tag (multi-strategy fuzzy match)
        let realMember = findMemberBySpeaker(seg.speaker, members);
        let name = realMember ? realMember.name : seg.speaker;

        appendMessage('char', applyMacros(cleanContent, name), name, false, msgIndex);
    });
}

function escapeHTML(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

function scrollToBottom() {
    var history = document.getElementById('chat-history');
    if (history) {
        history.scrollTop = history.scrollHeight;
    }
}

function setupChat() {
    var inputArea = document.getElementById('chat-input');
    var sendBtn = document.getElementById('send-btn');
    var banterBtn = document.getElementById('banter-btn');
    
    var isSending = false; // 二重送信防止フラグ
    var sendMessage = async function() {
        if (isSending) return; // 送信中は無視
        var text = inputArea.value.trim();
        if(!text) return;
        isSending = true;

        appendMessage('user', text, userConfig.name, true);
        
        inputArea.value = '';
        inputArea.disabled = true;
        sendBtn.disabled = true;
        banterBtn.disabled = true;
        
        var loadingName = 'Party';
        const members = getActivePartyMembers();
        if(members.length === 1) loadingName = members[0].name;

        var loadingId = 'loading-' + Date.now();
        appendLoadingMsg(loadingId, loadingName);
        
        try {
            var reply = await fetchChatCompletion();
            
            removeLoadingMsg(loadingId);
            
            if(reply) {
                splitAndAppendCharMessages(reply, true);
            }
        } catch (e) {
            removeLoadingMsg(loadingId);
            appendMessage('char', '[System Error] ' + e.message, 'System');
        } finally {
            isSending = false; // 送信完了
            inputArea.disabled = false;
            sendBtn.disabled = false;
            banterBtn.disabled = false;
            inputArea.focus();
        }
    };

    // NPC Banter (掛け合い)
    var triggerBanter = async function() {
        const members = getActivePartyMembers();
        if (members.length < 2) {
            alert('掛け合いには2人以上のキャラクターが必要です。');
            return;
        }
        
        inputArea.disabled = true;
        sendBtn.disabled = true;
        banterBtn.disabled = true;
        
        var loadingId = 'loading-' + Date.now();
        appendLoadingMsg(loadingId, '掛け合い中...');
        
        try {
            var reply = await fetchChatCompletion('banter');
            
            removeLoadingMsg(loadingId);
            
            if(reply) {
                splitAndAppendCharMessages(reply, true);
            }
        } catch (e) {
            removeLoadingMsg(loadingId);
            appendMessage('char', '[System Error] ' + e.message, 'System');
        } finally {
            inputArea.disabled = false;
            sendBtn.disabled = false;
            banterBtn.disabled = false;
            inputArea.focus();
        }
    };
    
    sendBtn.addEventListener('click', sendMessage);
    banterBtn.addEventListener('click', triggerBanter);
    inputArea.addEventListener('keydown', function(e) {
        if(e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    const exportChatBtn = document.getElementById('export-chat-btn');
    if (exportChatBtn) {
        exportChatBtn.addEventListener('click', exportChatLog);
    }
}

function appendLoadingMsg(id, name) {
    var chatContainer = document.getElementById('chat-history');
    var msgDiv = document.createElement('div');
    msgDiv.id = id;
    msgDiv.className = 'chat-msg char';
    
    var avatarImg = document.createElement('img');
    const members = getActivePartyMembers();
    
    var partySvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%237c4dff' d='M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z'/></svg>";
    
    var portraitSrc = partySvg;
    if (members.length === 1 && members[0].avatar) {
        portraitSrc = members[0].avatar;
    } else if (members.length > 1) {
        // Maybe use a combined icon later, for now party icon is fine
        portraitSrc = partySvg;
    } else if (members[0]) {
        portraitSrc = members[0].avatar || '/placeholder.png';
    } else {
        portraitSrc = '/placeholder.png';
    }
    
    avatarImg.src = portraitSrc;
    avatarImg.alt = name;
    avatarImg.className = 'msg-avatar';
    avatarImg.style.opacity = '0.5';
    
    var contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    contentDiv.style.opacity = '0.5';
    contentDiv.style.fontStyle = 'italic';
    contentDiv.textContent = '... typing ...';
    
    msgDiv.appendChild(avatarImg);
    msgDiv.appendChild(contentDiv);
    chatContainer.appendChild(msgDiv);
    scrollToBottom();
}

function removeLoadingMsg(id) {
    var el = document.getElementById(id);
    if(el) el.remove();
}

// ---- API Integration ----
async function fetchChatCompletion(mode) {
    const members = getActivePartyMembers();
    if (members.length === 0) throw new Error("No characters loaded in party.");
    if (!apiConfig.endpoint) throw new Error("API Endpoint is missing. Please check Settings.");
    
    // Construct System Prompt
    let systemPrompt = '';
    
    if (members.length === 1) {
        systemPrompt = 'Write the next response for the roleplay. You are playing the role of ' + members[0].name + '. Do not break character.\n'
            + '### ABSOLUTE RULE ###\n'
            + 'NEVER write dialogue, actions, or thoughts for ' + userConfig.name + ' (the player). Only the player decides what they say or do.\n\n'
            + '[User (Player) Info]\n'
            + 'Name: ' + userConfig.name + '\n'
            + (userConfig.personality ? 'Personality: ' + userConfig.personality + '\n' : '')
            + (userConfig.description ? 'Description:\n' + userConfig.description + '\n' : '')
            + (userConfig.mes_example ? 'Dialogue Style:\n' + userConfig.mes_example + '\n' : '')
            + '\n'
            + '[Character Info]\n'
            + 'Description:\n' + applyMacros(members[0].description, members[0].name) + '\n\n'
            + 'Personality: ' + applyMacros(members[0].personality, members[0].name) + '\n\n'
            + 'Scenario:\n' + applyMacros(members[0].scenario, members[0].name);

        if (members[0].system_prompt) {
            systemPrompt = applyMacros(members[0].system_prompt, members[0].name) + '\n\n' + systemPrompt;
        }
    } else {
        const names = members.map(m => m.name).join(', ');
        // Build dynamic example using actual character names
        const speakerExample = members.map(m =>
            `[SPEAKER: ${m.name}]\n（${m.name}のセリフや行動をここに書く）`
        ).join('\n');

        systemPrompt = 'あなたはゲームマスターとして、以下の複数キャラクターを演じてください: ' + names + '。\n'
            + '### 必須出力フォーマット ###\n'
            + '各キャラクターの発言・行動の前に、必ず以下の形式でスピーカータグを付けてください:\n'
            + '[SPEAKER: キャラクター名]\n'
            + '※キャラクター名は登録名をそのまま使ってください（英語に変換しないこと）。\n\n'
            + '地の文（ナレーション）やNPCの発言には必ず以下のタグを使ってください:\n'
            + '[SPEAKER: ナレーション]\n'
            + '（場面描写、状況説明、シナリオNPCの発言など）\n\n'
            + '例:\n'
            + '[SPEAKER: ナレーション]\n'
            + '（場面の描写や、シナリオNPCのセリフをここに書く）\n'
            + speakerExample + '\n\n'
            + '### 絶対禁止事項 ###\n'
            + '- ' + userConfig.name + '（プレイヤー）のセリフ・行動・思考を絶対に生成しないでください。\n'
            + '- ' + userConfig.name + ' が何を言うか、何をするかはプレイヤー自身が決めます。\n'
            + '- プレイヤーの代わりに返答を書くことは厳禁です。\n\n'
            + '[User (Player) Info]\n'
            + 'Name: ' + userConfig.name + '\n'
            + (userConfig.personality ? 'Personality: ' + userConfig.personality + '\n' : '')
            + (userConfig.description ? 'Description:\n' + userConfig.description + '\n' : '')
            + (userConfig.mes_example ? 'Dialogue Style:\n' + userConfig.mes_example + '\n' : '')
            + '\n';

        members.forEach(m => {
             systemPrompt += `========== [Character: ${m.name}] ==========\n`;
             if (m.system_prompt) systemPrompt += `Instruction: ${applyMacros(m.system_prompt, m.name)}\n`;
             systemPrompt += `Description: ${applyMacros(m.description, m.name)}\n`
                + `Personality: ${applyMacros(m.personality, m.name)}\n`
                + `Scenario: ${applyMacros(m.scenario, m.name)}\n`
                + `※${m.name}のセリフ・行動を書くときは、上記の設定に忠実に従ってください。\n\n`;
        });
    }
    
    // Banter mode: add special instruction
    if (mode === 'banter' && members.length >= 2) {
        const names = members.map(m => m.name).join('と');
        systemPrompt += `\n\n### 特別指示: キャラクター同士の掛け合い ###\n`
            + `${names}が自然に会話してください。ユーザーの介入はありません。\n`
            + `必ず [SPEAKER: キャラクター名] フォーマットを使い、登録名をそのまま使用してください。\n`;
    }

    // ======== QUEST CONTEXT INJECTION ========
    if (activeQuest && activeQuest.template) {
        const qt = activeQuest.template;
        const qs = activeQuest.state;

        // 1. AI Instructions (mandatory rules)
        if (qt.ai_instructions && qt.ai_instructions.length > 0) {
            systemPrompt += '\n\n========== クエスト指示 (必須遵守) ==========\n';
            qt.ai_instructions.forEach(instr => {
                if (instr.header) systemPrompt += `[${instr.header}]\n`;
                if (instr.content) systemPrompt += instr.content + '\n\n';
            });
            systemPrompt += '================================================\n';
        }

        // 2. Background + Additional Settings (always injected)
        if (qt.background) {
            systemPrompt += '\n\n========== クエスト背景 ==========\n'
                + qt.background + '\n'
                + '==================================\n';
        }
        if (qt.additional_settings && qt.additional_settings.length > 0) {
            systemPrompt += '\n========== 追加設定 ==========\n';
            qt.additional_settings.forEach(s => {
                systemPrompt += `[${s.title}] ${s.content}\n`;
            });
            systemPrompt += '==============================\n';
        }

        // 3. Current Event Progress
        if (qt.events && qt.events.length > 0) {
            const completedNames = qs.completed_events.map(eid => {
                const ev = qt.events.find(e => e.id === eid);
                return ev ? `${ev.id}. ${ev.title}` : '';
            }).filter(s => s).join(', ');

            const currentEvent = qt.events[qs.current_event_index];
            systemPrompt += '\n\n========== ストーリー進行状況 ==========\n';
            if (completedNames) {
                systemPrompt += '完了済みイベント: ' + completedNames + '\n';
            }
            if (currentEvent) {
                systemPrompt += `現在のイベント: ◇ ${currentEvent.id} ${currentEvent.title}\n`;
                systemPrompt += `内容: ${currentEvent.content}\n`;
                systemPrompt += '※このイベントの内容に沿って物語を進めてください。\n';
            }
            const nextEvent = qt.events[qs.current_event_index + 1];
            if (nextEvent) {
                systemPrompt += `次のイベント（予告のみ、先走らないこと）: ◇ ${nextEvent.id} ${nextEvent.title}\n`;
            }
            systemPrompt += '========================================\n';
        }

        // 4. Revealed Hidden Truths (only revealed ones)
        if (qt.hidden_truths && qt.hidden_truths.length > 0) {
            const revealed = qt.hidden_truths.filter(t => qs.revealed_truths.includes(t.id));
            if (revealed.length > 0) {
                systemPrompt += '\n\n========== 公開された真実 (物語に織り込むこと) ==========\n';
                revealed.forEach(t => {
                    systemPrompt += `[${t.title}] ${t.content}\n`;
                });
                systemPrompt += '========================================================\n';
            }
        }

        // 5. Prologue handling
        if (mode === 'quest_prologue' && qt.prologue_overview) {
            systemPrompt += '\n\n========== プロローグ生成指示 ==========\n'
                + '以下の概要に基づいて、クエストの冒頭シーンを生成してください。\n'
                + 'パーティ構成に合わせた描写をしてください。\n\n'
                + qt.prologue_overview + '\n'
                + '========================================\n';
        }
    }

    // Lorebook (Dynamic Knowledge Injection) - MOVED TO THE END FOR HIGHER WEIGHT
    const activeLore = [
        ...members.flatMap(m => m.lorebook || []),
        ...commonLorebook
    ];

    if (activeLore.length > 0) {
        // Scan last 10 messages + current user input for keyword matches
        const lastMsgs = chatHistory.slice(-10);
        const scanText = lastMsgs.map(m => m.content).join(' ').toLowerCase();

        if (scanText.trim()) {
            let loreInjected = '';
            const usedKeys = new Set();

            activeLore.forEach(entry => {
                if (!entry.key) return;
                // Support comma-separated keywords (e.g. "魔法の森,Magic Forest")
                const keywords = entry.key.split(',').map(k => k.trim()).filter(k => k);
                const matched = keywords.some(kw => scanText.includes(kw.toLowerCase()));
                if (matched && !usedKeys.has(entry.key)) {
                    loreInjected += `[LORE: ${entry.key}]\n${entry.content}\n\n`;
                    usedKeys.add(entry.key);
                }
            });
            if (loreInjected) {
                systemPrompt += '\n\n========== WORLD LORE (ABSOLUTE TRUTH - YOU MUST FOLLOW) ==========\n'
                    + 'These are established facts of this world. You MUST incorporate them into your response.\n'
                    + 'Contradicting these facts is strictly forbidden.\n\n'
                    + loreInjected
                    + '====================================================================\n';
            }
        }
    }

    // For banter mode, add a user message to trigger the AI

    // ── スライディングウィンドウ（コンテキスト上限対策）──
    // chatHistory本体は変えず、API送信用のみトリミングする
    const MAX_HISTORY_PAIRS = 10;   // 直近10往復（user + assistant）= 20エントリ
    const MAX_HISTORY_ENTRIES = MAX_HISTORY_PAIRS * 2;
    const trimmedHistory = chatHistory.length > MAX_HISTORY_ENTRIES
        ? chatHistory.slice(-MAX_HISTORY_ENTRIES)
        : chatHistory;
    // 古い履歴があることをAIに伝えるサマリーエントリを先頭に追加
    const historyWithContext = chatHistory.length > MAX_HISTORY_ENTRIES
        ? [
            { role: 'user',      content: '[これ以前にも会話の経緯があります。現在の場面から続けてください。]' },
            { role: 'assistant', content: '[了解しました。]' },
            ...trimmedHistory
          ]
        : trimmedHistory;

    var messages = [
        { role: 'system', content: systemPrompt },
        ...historyWithContext
    ];

    if (mode === 'banter') {
        messages.push({ role: 'user', content: `[システム: ${members.map(m => m.name).join('と')}が自由に会話してください。プレイヤーは見守っています。]` });
    }
    
    var payload = {
        model: apiConfig.model,
        messages: messages,
        temperature: 0.8,
        max_tokens: apiConfig.tokens
    };
    
    var headers = {
        'Content-Type': 'application/json'
    };
    
    if (apiConfig.key) {
        headers['Authorization'] = 'Bearer ' + apiConfig.key;
    }
    
    var response = await fetch(apiConfig.endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
        var errText = await response.text();
        throw new Error('API Error ' + response.status + ': ' + errText);
    }
    
    var result = await response.json();
    if(result.choices && result.choices.length > 0) {
        var content = result.choices[0].message.content;
        
        // --- 強力な <think> 除去処理 ---
        // 1. 基本的な <think>...</think> の除去（大文字小文字無視、複数対応）
        content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
        
        // 2. 閉じタグがない場合（トークン切れや生成途中）の対応
        // Qwen3などは思考が始まると <think> で始まるので、これ以降を一度切り捨てる
        if(content.includes('<think>')) {
             let parts = content.split('<think>');
             // <think>より前の部分だけを結合する（もし複数あれば）
             content = parts[0];
        }
        
        // タグの残骸などをトリム
        content = content.trim();
        
        // もし生成結果に対しても {{user}} だけは即座に適用したい場合はここで置き換える
        // ただし {{char}} は splitAndAppendCharMessages 内で話者ごとに適用する
        content = content.replace(/{{user}}/gi, userConfig.name);
        
        // もし除去した結果、空っぽになってしまった場合（思考プロセスしか出力されなかった場合）のガード
        if(!content) {
            return "(思考プロセスのみが返されました。Max Tokensを増やすか、もう一度試してみてください。)";
        }
        
        return content;
    } else {
        throw new Error("Invalid API response structure");
    }
}

// ======== QUEST UI SYSTEM ========
let editingQuestId = null; // ID of quest being edited, null for new quest

function setupQuestUI() {
    // Import quest file
    const importInput = document.getElementById('import-quest-file');
    if (importInput) {
        importInput.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            importQuestFromFile(file, function() {
                renderQuestLibrary();
                alert('クエストをインポートしました！');
            });
            e.target.value = '';
        });
    }

    // New quest button
    const newBtn = document.getElementById('new-quest-btn');
    if (newBtn) {
        newBtn.addEventListener('click', function() {
            editingQuestId = null;
            loadQuestIntoEditor(createEmptyQuest());
            showQuestEditor();
        });
    }

    // Back to library button
    const backBtn = document.getElementById('quest-back-btn');
    if (backBtn) {
        backBtn.addEventListener('click', function() {
            showQuestLibrary();
        });
    }

    // Save quest button
    const saveBtn = document.getElementById('save-quest-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', function() {
            const quest = getQuestFromEditor();
            if (editingQuestId) {
                quest.id = editingQuestId;
                updateQuest(quest);
            } else {
                addQuest(quest);
                editingQuestId = quest.id;
            }
            alert('クエストを保存しました！');
        });
    }

    // Export quest button
    const exportBtn = document.getElementById('export-quest-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', function() {
            const quest = getQuestFromEditor();
            exportQuest(quest);
        });
    }

    // Dynamic list add buttons
    setupDynamicListButton('add-ai-instruction-btn', 'quest-ai-instructions', 'ai_instruction');
    setupDynamicListButton('add-event-btn', 'quest-events', 'event');
    setupDynamicListButton('add-additional-setting-btn', 'quest-additional-settings', 'additional_setting');
    setupDynamicListButton('add-hidden-truth-btn', 'quest-hidden-truths', 'hidden_truth');
    setupDynamicListButton('add-item-clue-btn', 'quest-items-clues', 'item_clue');

    renderQuestLibrary();
}

function setupDynamicListButton(btnId, containerId, entryType) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', function() {
        const container = document.getElementById(containerId);
        if (!container) return;
        const index = container.children.length;
        container.appendChild(createQuestEntryElement(entryType, index, {}));
    });
}

function showQuestEditor() {
    document.getElementById('quest-library-view').classList.add('hidden');
    document.getElementById('quest-editor-view').classList.remove('hidden');
}

function showQuestLibrary() {
    document.getElementById('quest-editor-view').classList.add('hidden');
    document.getElementById('quest-library-view').classList.remove('hidden');
    renderQuestLibrary();
}

function renderQuestLibrary() {
    const grid = document.getElementById('quest-library-grid');
    if (!grid) return;

    if (savedQuests.length === 0) {
        grid.innerHTML = '<div class="loading">クエストがまだありません。「新規クエスト作成」または「インポート」で追加してください。</div>';
        return;
    }

    let html = '';
    savedQuests.forEach(function(quest) {
        const tags = (quest.metadata.tags || []).map(t => '<span class="quest-tag">' + escapeHTML(t) + '</span>').join('');
        const preview = quest.selection_text ? escapeHTML(quest.selection_text) : '<em>説明文なし</em>';
        const eventCount = (quest.events || []).length;
        const meta = '推奨: ' + (quest.metadata.recommended_party_size || '?') + '人 / イベント: ' + eventCount + '件';

        html += '<div class="quest-card" data-quest-id="' + quest.id + '">'
            + '<h3>' + escapeHTML(quest.metadata.name || '名称未設定') + '</h3>'
            + '<div class="quest-tags">' + tags + '</div>'
            + '<div class="quest-preview">' + preview + '</div>'
            + '<div class="quest-meta">' + meta + '</div>'
            + '<div class="quest-card-actions">'
            + '  <button class="quest-start-btn" data-id="' + quest.id + '">開始</button>'
            + '  <button class="quest-edit-btn" data-id="' + quest.id + '">編集</button>'
            + '  <button class="quest-export-btn" data-id="' + quest.id + '">出力</button>'
            + '  <button class="quest-delete-btn" data-id="' + quest.id + '">削除</button>'
            + '</div>'
            + '</div>';
    });
    grid.innerHTML = html;

    // Wire up card buttons
    grid.querySelectorAll('.quest-edit-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const quest = savedQuests.find(q => q.id === this.dataset.id);
            if (quest) {
                editingQuestId = quest.id;
                loadQuestIntoEditor(quest);
                showQuestEditor();
            }
        });
    });

    grid.querySelectorAll('.quest-export-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const quest = savedQuests.find(q => q.id === this.dataset.id);
            if (quest) exportQuest(quest);
        });
    });

    grid.querySelectorAll('.quest-delete-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const quest = savedQuests.find(q => q.id === this.dataset.id);
            if (quest && confirm('「' + quest.metadata.name + '」を削除しますか？')) {
                deleteQuest(quest.id);
                renderQuestLibrary();
            }
        });
    });

    grid.querySelectorAll('.quest-start-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const quest = savedQuests.find(q => q.id === this.dataset.id);
            if (quest) {
                startQuest(quest);
            }
        });
    });
}

// --- Quest Editor: Load/Get ---

function loadQuestIntoEditor(quest) {
    document.getElementById('quest-editor-title').textContent = editingQuestId ? 'クエスト編集' : '新規クエスト作成';
    document.getElementById('quest-name').value = quest.metadata.name || '';
    document.getElementById('quest-tags').value = (quest.metadata.tags || []).join(', ');
    document.getElementById('quest-author').value = quest.metadata.author || '';
    document.getElementById('quest-party-size').value = quest.metadata.recommended_party_size || 2;
    document.getElementById('quest-selection-text').value = quest.selection_text || '';
    document.getElementById('quest-prologue').value = quest.prologue_overview || '';
    document.getElementById('quest-background').value = quest.background || '';
    document.getElementById('quest-intro-dialogue').value = quest.introduction_dialogue || '';

    // Render dynamic lists
    renderQuestDynamicList('quest-ai-instructions', 'ai_instruction', quest.ai_instructions || []);
    renderQuestDynamicList('quest-events', 'event', quest.events || []);
    renderQuestDynamicList('quest-additional-settings', 'additional_setting', quest.additional_settings || []);
    renderQuestDynamicList('quest-hidden-truths', 'hidden_truth', quest.hidden_truths || []);
    renderQuestDynamicList('quest-items-clues', 'item_clue', quest.items_clues || []);
}

function getQuestFromEditor() {
    const quest = createEmptyQuest();
    if (editingQuestId) quest.id = editingQuestId;

    quest.metadata.name = document.getElementById('quest-name').value.trim();
    quest.metadata.tags = document.getElementById('quest-tags').value.split(',').map(t => t.trim()).filter(t => t);
    quest.metadata.author = document.getElementById('quest-author').value.trim();
    quest.metadata.recommended_party_size = parseInt(document.getElementById('quest-party-size').value) || 2;
    quest.selection_text = document.getElementById('quest-selection-text').value.trim();
    quest.prologue_overview = document.getElementById('quest-prologue').value.trim();
    quest.background = document.getElementById('quest-background').value.trim();
    quest.introduction_dialogue = document.getElementById('quest-intro-dialogue').value.trim();

    quest.ai_instructions = getQuestDynamicList('quest-ai-instructions', 'ai_instruction');
    quest.events = getQuestDynamicList('quest-events', 'event');
    quest.additional_settings = getQuestDynamicList('quest-additional-settings', 'additional_setting');
    quest.hidden_truths = getQuestDynamicList('quest-hidden-truths', 'hidden_truth');
    quest.items_clues = getQuestDynamicList('quest-items-clues', 'item_clue');

    return quest;
}

// --- Quest Editor: Dynamic List Rendering ---

function renderQuestDynamicList(containerId, entryType, items) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    items.forEach(function(item, index) {
        container.appendChild(createQuestEntryElement(entryType, index, item));
    });
}

function createQuestEntryElement(entryType, index, data) {
    const div = document.createElement('div');
    div.className = 'quest-entry';
    div.dataset.type = entryType;

    let fieldsHtml = '';

    switch (entryType) {
        case 'ai_instruction':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>ヘッダー (例: 主目的)</label><input type="text" class="qe-header" value="${escapeHTML(data.header || '')}"></div>
                <div class="form-group"><label>内容</label><textarea class="qe-content" rows="3">${escapeHTML(data.content || '')}</textarea></div>
            `;
            break;
        case 'event':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>イベント名</label><input type="text" class="qe-title" value="${escapeHTML(data.title || '')}"></div>
                <div class="form-group"><label>内容</label><textarea class="qe-content" rows="3">${escapeHTML(data.content || '')}</textarea></div>
            `;
            break;
        case 'additional_setting':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>設定名</label><input type="text" class="qe-title" value="${escapeHTML(data.title || '')}"></div>
                <div class="form-group"><label>内容</label><textarea class="qe-content" rows="3">${escapeHTML(data.content || '')}</textarea></div>
            `;
            break;
        case 'hidden_truth':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>真実の名前</label><input type="text" class="qe-title" value="${escapeHTML(data.title || '')}"></div>
                <div class="form-group"><label>内容</label><textarea class="qe-content" rows="3">${escapeHTML(data.content || '')}</textarea></div>
                <div class="form-group"><label>公開タイミング (イベント番号。0=手動)</label><input type="number" class="qe-reveal-after" min="0" value="${data.reveal_after_event || 0}"></div>
            `;
            break;
        case 'item_clue':
            fieldsHtml = `
                <div class="entry-header"><span class="entry-number">${index + 1}</span></div>
                <div class="form-group"><label>名前</label><input type="text" class="qe-name" value="${escapeHTML(data.name || '')}"></div>
                <div class="form-group"><label>説明</label><textarea class="qe-content" rows="2">${escapeHTML(data.description || '')}</textarea></div>
            `;
            break;
    }

    div.innerHTML = fieldsHtml + '<button class="remove-entry-btn" title="削除">✕</button>';

    div.querySelector('.remove-entry-btn').addEventListener('click', function() {
        div.remove();
        // Re-number siblings
        const container = div.parentElement;
        if (container) {
            container.querySelectorAll('.quest-entry').forEach((el, i) => {
                const num = el.querySelector('.entry-number');
                if (num) num.textContent = i + 1;
            });
        }
    });

    return div;
}

function getQuestDynamicList(containerId, entryType) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    const items = [];

    container.querySelectorAll('.quest-entry').forEach(function(el, index) {
        switch (entryType) {
            case 'ai_instruction':
                items.push({
                    header: (el.querySelector('.qe-header') || {}).value || '',
                    content: (el.querySelector('.qe-content') || {}).value || ''
                });
                break;
            case 'event':
                items.push({
                    id: index + 1,
                    title: (el.querySelector('.qe-title') || {}).value || '',
                    content: (el.querySelector('.qe-content') || {}).value || ''
                });
                break;
            case 'additional_setting':
                items.push({
                    title: (el.querySelector('.qe-title') || {}).value || '',
                    content: (el.querySelector('.qe-content') || {}).value || ''
                });
                break;
            case 'hidden_truth':
                items.push({
                    id: index + 1,
                    title: (el.querySelector('.qe-title') || {}).value || '',
                    content: (el.querySelector('.qe-content') || {}).value || '',
                    reveal_after_event: parseInt((el.querySelector('.qe-reveal-after') || {}).value) || 0
                });
                break;
            case 'item_clue':
                items.push({
                    name: (el.querySelector('.qe-name') || {}).value || '',
                    description: (el.querySelector('.qe-content') || {}).value || ''
                });
                break;
        }
    });
    return items;
}

// --- Quest Start ---
async function startQuest(quest) {
    if (activeQuest) {
        if (!confirm('既にアクティブなクエストがあります。新しいクエストを開始しますか？')) return;
    }

    const members = getActivePartyMembers();
    if (members.length === 0) {
        alert('パーティにキャラクターがいません。Party Setup からキャラクターを登録してください。');
        return;
    }

    activeQuest = {
        template: JSON.parse(JSON.stringify(quest)),
        state: {
            current_event_index: 0,
            completed_events: [],
            revealed_truths: [],
            prologue_delivered: false,
            items_shown: false
        }
    };
    saveActiveQuest();

    // Reset chat for new quest
    chatHistory = [];
    document.getElementById('chat-history').innerHTML = '';
    saveChatHistory();

    // Switch to chat view
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(v => v.classList.add('hidden'));
    const chatNav = document.querySelector('[data-view="chat-view"]');
    if (chatNav) chatNav.classList.add('active');
    document.getElementById('chat-view').classList.remove('hidden');

    updateQuestHUD();

    // Deliver prologue
    if (quest.introduction_dialogue && quest.introduction_dialogue.trim()) {
        // Fixed dialogue prologue
        appendMessage('char', quest.introduction_dialogue, 'ナレーション', true);
        activeQuest.state.prologue_delivered = true;
        activeQuest.state.items_shown = true;
        saveActiveQuest();
    } else if (quest.prologue_overview && quest.prologue_overview.trim()) {
        // AI-generated prologue
        appendMessage('system', 'クエスト「' + quest.metadata.name + '」を開始します...プロローグを生成中...', 'System', false);
        try {
            const reply = await fetchChatCompletion('quest_prologue');
            // Remove loading message
            const chatContainer = document.getElementById('chat-history');
            const lastMsg = chatContainer.lastElementChild;
            if (lastMsg && lastMsg.classList.contains('system')) lastMsg.remove();

            splitAndAppendCharMessages(reply, true);
            activeQuest.state.prologue_delivered = true;
            activeQuest.state.items_shown = true;
            saveActiveQuest();
        } catch (err) {
            appendMessage('system', 'プロローグ生成エラー: ' + err.message, 'System', false);
        }
    } else {
        appendMessage('system', 'クエスト「' + quest.metadata.name + '」を開始しました。メッセージを送信してプレイを始めてください。', 'System', false);
        activeQuest.state.prologue_delivered = true;
        saveActiveQuest();
    }
}

function endQuest() {
    if (!activeQuest) return;
    if (!confirm('クエスト「' + activeQuest.template.metadata.name + '」を終了しますか？')) return;
    activeQuest = null;
    saveActiveQuest();
    updateQuestHUD();
}

function advanceQuestEvent() {
    if (!activeQuest) return;
    const events = activeQuest.template.events || [];
    const currentIdx = activeQuest.state.current_event_index;
    if (currentIdx >= events.length) return;

    // Mark current event as completed
    const currentEvent = events[currentIdx];
    if (currentEvent && !activeQuest.state.completed_events.includes(currentEvent.id)) {
        activeQuest.state.completed_events.push(currentEvent.id);
    }

    // Auto-reveal truths tied to this event
    const truths = activeQuest.template.hidden_truths || [];
    truths.forEach(t => {
        if (t.reveal_after_event === currentEvent.id && !activeQuest.state.revealed_truths.includes(t.id)) {
            activeQuest.state.revealed_truths.push(t.id);
        }
    });

    // Advance to next event
    if (currentIdx < events.length - 1) {
        activeQuest.state.current_event_index = currentIdx + 1;
    }

    saveActiveQuest();
    updateQuestHUD();

    // Notify in chat
    const nextEvent = events[activeQuest.state.current_event_index];
    if (nextEvent && currentIdx < events.length - 1) {
        appendMessage('system', '📍 次のイベント: ' + nextEvent.title, 'System', false);
    } else {
        appendMessage('system', '🏁 全イベントが完了しました！', 'System', false);
    }
}

function revealQuestTruth(truthId) {
    if (!activeQuest) return;
    if (!activeQuest.state.revealed_truths.includes(truthId)) {
        activeQuest.state.revealed_truths.push(truthId);
        saveActiveQuest();
        updateQuestHUD();
        const truth = (activeQuest.template.hidden_truths || []).find(t => t.id === truthId);
        if (truth) {
            appendMessage('system', '🔓 真実が明かされた: 「' + truth.title + '」', 'System', false);
        }
    }
}

function updateQuestHUD() {
    const hud = document.getElementById('quest-hud');
    if (!hud) return;

    if (!activeQuest) {
        hud.classList.add('hidden');
        return;
    }

    hud.classList.remove('hidden');
    const qt = activeQuest.template;
    const qs = activeQuest.state;
    const events = qt.events || [];

    // Name & progress
    document.getElementById('quest-hud-name').textContent = qt.metadata.name || 'クエスト';
    document.getElementById('quest-hud-progress').textContent =
        events.length > 0 ? `Event ${qs.current_event_index + 1} / ${events.length}` : '';

    // Dots
    const dotsContainer = document.getElementById('quest-hud-dots');
    dotsContainer.innerHTML = '';
    events.forEach((ev, i) => {
        const dot = document.createElement('span');
        dot.className = 'dot';
        if (qs.completed_events.includes(ev.id)) dot.classList.add('completed');
        if (i === qs.current_event_index && !qs.completed_events.includes(ev.id)) dot.classList.add('current');
        dot.title = ev.title || `Event ${i + 1}`;
        dotsContainer.appendChild(dot);
    });

    // Reveal truths dropdown
    const revealSelect = document.getElementById('quest-reveal-select');
    revealSelect.innerHTML = '<option value="">真実を公開...</option>';
    (qt.hidden_truths || []).forEach(t => {
        if (!qs.revealed_truths.includes(t.id)) {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.title;
            revealSelect.appendChild(opt);
        }
    });

    // Items panel
    const itemsList = document.getElementById('quest-items-list');
    if (itemsList) {
        const items = qt.items_clues || [];
        if (items.length > 0 && qs.items_shown) {
            itemsList.innerHTML = items.map(item =>
                '<div class="quest-item-entry">'
                + '<div class="item-name">' + escapeHTML(item.name) + '</div>'
                + '<div class="item-desc">' + escapeHTML(item.description) + '</div>'
                + '</div>'
            ).join('');
        } else {
            itemsList.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.85rem;">アイテムはまだ表示されていません。</div>';
        }
    }
}

function setupQuestHUD() {
    const advanceBtn = document.getElementById('quest-advance-btn');
    if (advanceBtn) {
        advanceBtn.addEventListener('click', advanceQuestEvent);
    }

    const endBtn = document.getElementById('quest-end-btn');
    if (endBtn) {
        endBtn.addEventListener('click', endQuest);
    }

    const revealSelect = document.getElementById('quest-reveal-select');
    if (revealSelect) {
        revealSelect.addEventListener('change', function() {
            const truthId = parseInt(this.value);
            if (truthId) {
                revealQuestTruth(truthId);
                this.value = '';
            }
        });
    }

    const itemsToggle = document.getElementById('quest-items-toggle');
    if (itemsToggle) {
        itemsToggle.addEventListener('click', function() {
            const panel = document.getElementById('quest-items-panel');
            if (panel) panel.classList.toggle('hidden');
        });
    }
}

// ======== END QUEST UI SYSTEM ========

// ======== CHAT LOG HTML EXPORT ========

/**
 * chatHistory の各エントリを表示用セグメントに変換する純粋関数。
 * DOM 操作なし。
 * @returns {Array<{role, speakerName, content, avatarSrc, isNarrator}>}
 */
function parseChatHistoryToSegments() {
    const members = getActivePartyMembers();

    // SVG フォールバックアイコン（appendMessage と同じ定義）
    const userSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23aaa' d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>";
    const narratorSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23c0a0ff' d='M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z'/></svg>";
    const unknownCharSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23666' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z'/></svg>";

    function getCharAvatar(name) {
        if (name === 'ナレーション' || name === 'Narrator' || name === 'System') return narratorSvg;
        const member = findMemberBySpeaker(name, members);
        return (member && member.avatar) ? member.avatar : unknownCharSvg;
    }

    const segments = [];

    chatHistory.forEach(entry => {
        if (entry.role === 'user') {
            segments.push({
                role: 'user',
                speakerName: userConfig.name,
                content: entry.content,
                avatarSrc: userConfig.avatar || userSvg,
                isNarrator: false
            });
            return;
        }

        // assistant メッセージ
        const fullReply = entry.content;

        if (members.length === 1) {
            const name = members[0].name;
            segments.push({
                role: 'char',
                speakerName: name,
                content: applyMacros(fullReply, name),
                avatarSrc: getCharAvatar(name),
                isNarrator: false
            });
            return;
        }

        // マルチキャラ: [SPEAKER:] タグがあるか確認
        const tagRegex = /\[SPEAKER:\s*([^\]]+)\]/gi;
        if (!tagRegex.test(fullReply)) {
            // フォールバック: 名前プレフィックスで分割（splitAndAppendCharMessages と同ロジック）
            const namePatterns = members.map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            const nameGroup = namePatterns.join('|');
            const fallbackRegex = new RegExp(
                '(?=(?:^|\\n)\\s*(?:'
                + '\\*\\*(?:' + nameGroup + ')\\**\\s*[：:]\\s*\\**'
                + '|【(?:' + nameGroup + ')】'
                + '|[―—](?:' + nameGroup + ')[―—]'
                + '|(?:' + nameGroup + ')\\s*[：:]'
                + '|(?:' + nameGroup + ')「'
                + '))', 'g');
            const parts = fullReply.split(fallbackRegex).filter(s => s.trim());
            parts.forEach(seg => {
                let trimmed = seg.trim();
                let speakerName = members[0].name;
                for (const m of members) {
                    const esc = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const prefixPatterns = [
                        new RegExp('^\\*\\*' + esc + '\\**\\s*[：:]\\s*\\**\\s*', ''),
                        new RegExp('^【' + esc + '】\\s*', ''),
                        new RegExp('^[―—]' + esc + '[―—]\\s*', ''),
                        new RegExp('^' + esc + '\\s*[：:]\\s*', ''),
                        new RegExp('^' + esc + '(?=「)', ''),
                    ];
                    for (const pRegex of prefixPatterns) {
                        if (pRegex.test(trimmed)) {
                            speakerName = m.name;
                            trimmed = trimmed.replace(pRegex, '');
                            break;
                        }
                    }
                }
                if (trimmed) {
                    segments.push({
                        role: 'char',
                        speakerName,
                        content: applyMacros(trimmed, speakerName),
                        avatarSrc: getCharAvatar(speakerName),
                        isNarrator: speakerName === 'ナレーション' || speakerName === 'Narrator'
                    });
                }
            });
            return;
        }

        // タグベース分割
        tagRegex.lastIndex = 0;
        const tagSegments = [];
        let match;
        let lastIndex = 0;
        while ((match = tagRegex.exec(fullReply)) !== null) {
            if (tagSegments.length === 0 && match.index > 0) {
                const preText = fullReply.substring(0, match.index).trim();
                if (preText) tagSegments.push({ speaker: 'ナレーション', content: preText });
            } else if (tagSegments.length > 0) {
                tagSegments[tagSegments.length - 1].content = fullReply.substring(lastIndex, match.index).trim();
            }
            tagSegments.push({ speaker: match[1].trim(), content: '' });
            lastIndex = tagRegex.lastIndex;
        }
        if (tagSegments.length > 0) {
            tagSegments[tagSegments.length - 1].content = fullReply.substring(lastIndex).trim();
        }

        tagSegments.forEach(seg => {
            const cleanContent = seg.content.replace(/\[SPEAKER:\s*[^\]]+\]/gi, '').trim();
            if (!cleanContent) return;
            const speakerLower = seg.speaker.trim().toLowerCase();
            if (speakerLower === userConfig.name.toLowerCase()) return; // {{user}}発言は除外
            const realMember = findMemberBySpeaker(seg.speaker, members);
            const speakerName = realMember ? realMember.name : seg.speaker;
            segments.push({
                role: 'char',
                speakerName,
                content: applyMacros(cleanContent, speakerName),
                avatarSrc: getCharAvatar(speakerName),
                isNarrator: speakerName === 'ナレーション' || speakerName === 'Narrator'
            });
        });
    });

    return segments;
}

/**
 * チャットログをスタンドアロン HTML ファイルとしてダウンロードする。
 */
function exportChatLog() {
    if (chatHistory.length === 0) {
        alert('エクスポートするチャット履歴がありません。');
        return;
    }

    const segments = parseChatHistoryToSegments();
    const members = getActivePartyMembers();

    // ファイル名用のタイトル
    const questName = (activeQuest && activeQuest.template && activeQuest.template.metadata && activeQuest.template.metadata.name)
        ? activeQuest.template.metadata.name
        : (members.length > 0 ? members.map(m => m.name).join('・') : 'Chat');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = 'chatlog_' + questName.replace(/[\\/:*?"<>|]/g, '_') + '_' + timestamp + '.html';

    // セグメントを HTML バブルに変換
    function segToHtml(seg) {
        const isUser = seg.role === 'user';
        const isNarrator = seg.isNarrator;
        const escapedContent = seg.content
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        const escapedName = seg.speakerName
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        if (isNarrator) {
            return `
        <div class="msg narrator">
          <img class="avatar" src="${seg.avatarSrc}" alt="ナレーション">
          <div class="bubble narrator-bubble">${escapedContent}</div>
        </div>`;
        }
        if (isUser) {
            return `
        <div class="msg user">
          <div class="bubble user-bubble">
            <div class="speaker">${escapedName}</div>
            ${escapedContent}
          </div>
          <img class="avatar" src="${seg.avatarSrc}" alt="${escapedName}">
        </div>`;
        }
        return `
        <div class="msg char">
          <img class="avatar" src="${seg.avatarSrc}" alt="${escapedName}">
          <div class="bubble char-bubble">
            <div class="speaker">${escapedName}</div>
            ${escapedContent}
          </div>
        </div>`;
    }

    const bubblesHtml = segments.map(segToHtml).join('\n');

    // クエスト情報バナー
    let questBannerHtml = '';
    if (activeQuest && activeQuest.template) {
        const qt = activeQuest.template;
        const tagsHtml = (qt.metadata.tags || []).map(t => `<span class="tag">${t.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>`).join(' ');
        questBannerHtml = `
      <div class="quest-banner">
        <div class="quest-banner-title">📜 ${qt.metadata.name.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
        <div class="quest-banner-tags">${tagsHtml}</div>
      </div>`;
    }

    // パーティ情報
    const partyNames = members.map(m => m.name).join(' / ');
    const exportDateStr = new Date().toLocaleString('ja-JP');

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chat Log — ${questName.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      background: #0f1117;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 2rem 1rem;
    }
    .page-header {
      max-width: 760px;
      margin: 0 auto 1.5rem;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 1.2rem 1.5rem;
    }
    .page-header h1 {
      font-size: 1.2rem;
      color: #a0a6b5;
      font-weight: 400;
    }
    .page-header .meta {
      margin-top: 0.4rem;
      font-size: 0.82rem;
      color: #666;
    }
    .quest-banner {
      max-width: 760px;
      margin: 0 auto 1.2rem;
      background: rgba(124, 77, 255, 0.12);
      border: 1px solid rgba(124, 77, 255, 0.3);
      border-radius: 12px;
      padding: 0.9rem 1.2rem;
    }
    .quest-banner-title {
      font-size: 1rem;
      font-weight: 600;
      color: #c9b8ff;
    }
    .quest-banner-tags {
      margin-top: 0.4rem;
    }
    .tag {
      display: inline-block;
      background: rgba(124,77,255,0.2);
      color: #b8a0ff;
      border-radius: 20px;
      padding: 0.15rem 0.6rem;
      font-size: 0.75rem;
      margin-right: 0.3rem;
    }
    .chat-log {
      max-width: 760px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .msg {
      display: flex;
      align-items: flex-start;
      gap: 0.7rem;
    }
    .msg.user {
      flex-direction: row-reverse;
    }
    .msg.narrator {
      justify-content: center;
    }
    .avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      background: #1a1d26;
    }
    .bubble {
      max-width: 68%;
      padding: 0.65rem 0.9rem;
      border-radius: 16px;
      line-height: 1.55;
      font-size: 0.92rem;
    }
    .char-bubble {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-top-left-radius: 4px;
    }
    .user-bubble {
      background: rgba(124, 77, 255, 0.25);
      border: 1px solid rgba(124, 77, 255, 0.35);
      border-top-right-radius: 4px;
      text-align: right;
    }
    .narrator-bubble {
      max-width: 90%;
      background: rgba(80, 70, 120, 0.25);
      border-left: 3px solid rgba(180, 160, 255, 0.5);
      border-radius: 8px;
      font-style: italic;
      color: #c0b8e0;
      padding: 0.6rem 1rem;
    }
    .speaker {
      font-size: 0.75rem;
      font-weight: 600;
      margin-bottom: 0.3rem;
      opacity: 0.7;
      letter-spacing: 0.03em;
    }
    .page-footer {
      max-width: 760px;
      margin: 2rem auto 0;
      text-align: center;
      font-size: 0.75rem;
      color: #444;
    }
  </style>
</head>
<body>
  <div class="page-header">
    <h1>📖 RP Game Engine — Chat Log</h1>
    <div class="meta">
      Party: ${partyNames.replace(/&/g,'&amp;').replace(/</g,'&lt;')} &nbsp;|&nbsp;
      Player: ${userConfig.name.replace(/&/g,'&amp;').replace(/</g,'&lt;')} &nbsp;|&nbsp;
      Export: ${exportDateStr}
    </div>
  </div>
  ${questBannerHtml}
  <div class="chat-log">
${bubblesHtml}
  </div>
  <div class="page-footer">Generated by RP Game Engine</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ======== END CHAT LOG EXPORT ========

init();
