import './style.css'

let characterDataArray = [null, null, null];
let commonLorebook = [];
let activeSlotIndex = 0; // 0, 1, or 2
let chatHistory = [];
// API Configuration stored in localStorage or defaults
let apiConfig = {
    endpoint: localStorage.getItem('apiEndpoint') || 'http://localhost:5001/v1/chat/completions',
    key: localStorage.getItem('apiKey') || 'none',
    model: localStorage.getItem('apiModel') || 'local-model',
    tokens: parseInt(localStorage.getItem('apiTokens')) || 1000
};

let userConfig = {
    name: localStorage.getItem('userName') || 'User',
    persona: localStorage.getItem('userPersona') || '',
    avatar: localStorage.getItem('userAvatar') || ''
};

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
    setupUserEditor();
    setupChat();
    
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
        
        // Use party ID for chat history
        const partyId = Array.from(characterDataArray).map(c => c ? c.name : 'empty').join('-');
        const savedChat = localStorage.getItem('chatHistory_' + partyId);
        if (savedChat) {
            chatHistory = JSON.parse(savedChat);
            // Restore visual messages
            document.getElementById('chat-history').innerHTML = '';
            chatHistory.forEach(msg => {
                const role = msg.role === 'assistant' ? 'char' : 'user';
                // Try to infer name (will be more complex with multiple chars, simplify for now)
                const name = role === 'char' ? (characterDataArray[0].name || 'Assistant') : userConfig.name;
                appendMessage(role, msg.content, name, false);
            });
        } else {
            initializeChat(characterDataArray);
        }
        setupCharacterEditor();
        updateSlotTabNames();
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
            if (confirm('現在の会話履歴を削除して、最初からやり直しますか？')) {
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
function setupUserEditor() {
    document.getElementById('user-name').value = userConfig.name;
    document.getElementById('user-persona').value = userConfig.persona;
    
    // User Avatar Upload
    document.getElementById('user-avatar-upload').addEventListener('change', function(e) {
        var file = e.target.files[0];
        if(!file) return;
        var reader = new FileReader();
        reader.onload = function(event) {
            userConfig.avatar = event.target.result;
            // 画面のアイコンを即座に更新する処理
        };
        reader.readAsDataURL(file);
    });
    
    document.getElementById('save-user-btn').addEventListener('click', function() {
        userConfig.name = document.getElementById('user-name').value || 'User';
        userConfig.persona = document.getElementById('user-persona').value;
        
        localStorage.setItem('userName', userConfig.name);
        localStorage.setItem('userPersona', userConfig.persona);
        if(userConfig.avatar) {
            localStorage.setItem('userAvatar', userConfig.avatar);
        }
        alert('User Persona saved!');
    });
}

function setupCharacterEditor() {
    // Setup tabs
    const tabs = document.querySelectorAll('.slot-tab');
    tabs.forEach(tab => {
        // Remove old listeners to prevent duplication on re-init
        const newTab = tab.cloneNode(true);
        tab.parentNode.replaceChild(newTab, tab);
        
        newTab.addEventListener('click', function() {
            document.querySelectorAll('.slot-tab').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            activeSlotIndex = parseInt(this.getAttribute('data-slot'));
            loadSlotIntoEditor();
        });
    });
    
    // Setup file inputs and buttons just once by cloning
    const btnSave = document.getElementById('save-char-btn');
    const newBtnSave = btnSave.cloneNode(true);
    btnSave.parentNode.replaceChild(newBtnSave, btnSave);

    const btnImport = document.getElementById('import-char-file');
    const newBtnImport = btnImport.cloneNode(true);
    btnImport.parentNode.replaceChild(newBtnImport, btnImport);

    const btnExport = document.getElementById('export-char-btn');
    const newBtnExport = btnExport.cloneNode(true);
    btnExport.parentNode.replaceChild(newBtnExport, btnExport);

    const targetAvatar = document.getElementById('edit-char-avatar');
    const newTargetAvatar = targetAvatar.cloneNode(true);
    targetAvatar.parentNode.replaceChild(newTargetAvatar, targetAvatar);

    // Initial load
    loadSlotIntoEditor();
    
    // Listeners
    newTargetAvatar.addEventListener('change', function(e) {
        var file = e.target.files[0];
        if(!file) return;
        var reader = new FileReader();
        reader.onload = function(event) {
            if(characterDataArray[activeSlotIndex]) {
                 characterDataArray[activeSlotIndex].avatar = event.target.result;
            }
        };
        reader.readAsDataURL(file);
    });
    
    newBtnSave.addEventListener('click', function() {
        if(!characterDataArray[activeSlotIndex]) characterDataArray[activeSlotIndex] = {};
        let activeChar = characterDataArray[activeSlotIndex];
        
        activeChar.name = document.getElementById('edit-char-name').value;
        activeChar.personality = document.getElementById('edit-char-personality').value;
        activeChar.description = document.getElementById('edit-char-desc').value;
        activeChar.scenario = document.getElementById('edit-char-scenario').value;
        activeChar.first_mes = document.getElementById('edit-char-firstmes').value;
        activeChar.mes_example = document.getElementById('edit-char-examples').value;
        activeChar.lorebook = getLorebookFromEditor();
        
        // Also save Common Lore if we are in this panel
        commonLorebook = getCommonLorebookFromEditor();
        
        localStorage.setItem('savedParty', JSON.stringify(characterDataArray));
        localStorage.setItem('savedCommonLore', JSON.stringify(commonLorebook));
        renderPartySheet();
        updateSlotTabNames();
        alert(`Slot ${activeSlotIndex + 1} and Common Lore updated!`);
    });

    const addLoreBtn = document.getElementById('add-lore-btn');
    const newAddLoreBtn = addLoreBtn.cloneNode(true);
    addLoreBtn.parentNode.replaceChild(newAddLoreBtn, addLoreBtn);
    
    newAddLoreBtn.addEventListener('click', function() {
        let activeChar = characterDataArray[activeSlotIndex];
        if(!activeChar) return;
        if (!activeChar.lorebook) activeChar.lorebook = [];
        activeChar.lorebook.push({ key: '', content: '' });
        renderLorebookEditor();
    });

    const addCommonLoreBtn = document.getElementById('add-common-lore-btn');
    const newAddCommonLoreBtn = addCommonLoreBtn.cloneNode(true);
    addCommonLoreBtn.parentNode.replaceChild(newAddCommonLoreBtn, addCommonLoreBtn);

    newAddCommonLoreBtn.addEventListener('click', function() {
        commonLorebook.push({ key: '', content: '' });
        renderCommonLorebookEditor();
    });

    const saveCommonLoreBtn = document.getElementById('save-common-lore-btn');
    saveCommonLoreBtn.addEventListener('click', function() {
        commonLorebook = getCommonLorebookFromEditor();
        localStorage.setItem('savedCommonLore', JSON.stringify(commonLorebook));
        alert('Global Lorebook saved!');
    });

    // Import Character
    newBtnImport.addEventListener('change', function(e) {
        var file = e.target.files[0];
        if(!file) return;
        var reader = new FileReader();
        reader.onload = function(event) {
            try {
                var json = JSON.parse(event.target.result);
                var targetData = json.engine_data ? json.engine_data : (json.data ? json.data : json);
                
                characterDataArray[activeSlotIndex] = targetData;
                localStorage.setItem('savedParty', JSON.stringify(characterDataArray));
                renderPartySheet();
                updateSlotTabNames();
                loadSlotIntoEditor(); // refresh fields
                alert(`Character imported into Slot ${activeSlotIndex + 1}!`);
            } catch(err) {
                alert('Failed to parse JSON file.');
            }
        };
        reader.readAsText(file);
    });
    
    // Export Character
    newBtnExport.addEventListener('click', function() {
        let activeChar = characterDataArray[activeSlotIndex];
        if(!activeChar) return;
        var exportObj = {
            spec: "rp_engine_v1",
            engine_data: activeChar
        };
        var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj, null, 2));
        var downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", (activeChar.name || "character") + ".json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    });

    // ---- Party Management ----
    const exportPartyBtn = document.getElementById('export-party-btn');
    const importPartyFile = document.getElementById('import-party-file');

    exportPartyBtn.addEventListener('click', function() {
        const exportObj = {
            spec: "rp_engine_party_v1",
            party: characterDataArray,
            common_lore: commonLorebook,
            user_config: userConfig
        };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "party_export_" + Date.now() + ".json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    });

    importPartyFile.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const json = JSON.parse(event.target.result);
                if (json.spec === "rp_engine_party_v1") {
                    characterDataArray = json.party;
                    commonLorebook = json.common_lore || [];
                    if (json.user_config) userConfig = json.user_config;

                    localStorage.setItem('savedParty', JSON.stringify(characterDataArray));
                    localStorage.setItem('savedCommonLore', JSON.stringify(commonLorebook));
                    
                    renderPartySheet();
                    updateSlotTabNames();
                    loadSlotIntoEditor();
                    alert('Party imported successfully!');
                } else {
                    alert('Invalid party export file.');
                }
            } catch(err) {
                alert('Failed to parse JSON file.');
            }
        };
        reader.readAsText(file);
    });

    // Clear Slot
    const clearSlotBtn = document.getElementById('clear-slot-btn');
    const newClearBtn = clearSlotBtn.cloneNode(true);
    clearSlotBtn.parentNode.replaceChild(newClearBtn, clearSlotBtn);

    newClearBtn.addEventListener('click', function() {
        if (confirm(`Slot ${activeSlotIndex + 1} のデータをクリアしますか？`)) {
            characterDataArray[activeSlotIndex] = {
                name: `Slot ${activeSlotIndex + 1} Empty`,
                tags: ["Draft"],
                personality: "Unknown",
                description: "",
                scenario: "",
                first_mes: "",
                mes_example: "",
                avatar: "",
                lorebook: []
            };
            localStorage.setItem('savedParty', JSON.stringify(characterDataArray));
            loadSlotIntoEditor();
            renderPartySheet();
            updateSlotTabNames();
        }
    });
}

function loadSlotIntoEditor() {
    let char = characterDataArray[activeSlotIndex];
    if(!char) {
        char = { name: '', personality: '', description: '', scenario: '', first_mes: '', mes_example: '', lorebook: [], avatar: '' };
        characterDataArray[activeSlotIndex] = char;
    }
    
    document.getElementById('edit-char-name').value = char.name || '';
    document.getElementById('edit-char-personality').value = char.personality || '';
    document.getElementById('edit-char-desc').value = char.description || '';
    document.getElementById('edit-char-scenario').value = char.scenario || '';
    document.getElementById('edit-char-firstmes').value = char.first_mes || '';
    document.getElementById('edit-char-examples').value = char.mes_example || '';
    
    // Avatar preview
    const previewDiv = document.getElementById('slot-avatar-preview');
    if (previewDiv) {
        if (char.avatar) {
            previewDiv.innerHTML = `<img src="${char.avatar}" alt="${escapeHTML(char.name || '')}" class="slot-preview-img">`;
        } else {
            previewDiv.innerHTML = '<div class="slot-preview-empty">アイコン未設定</div>';
        }
    }
    
    renderLorebookEditor();
    renderCommonLorebookEditor();
}

function updateSlotTabNames() {
    document.querySelectorAll('.slot-tab').forEach(tab => {
        const idx = parseInt(tab.getAttribute('data-slot'));
        const char = characterDataArray[idx];
        if (char && char.name && !char.name.includes('Empty')) {
            tab.textContent = char.name.substring(0, 12);
        } else {
            tab.textContent = `Slot ${idx + 1}`;
        }
    });
}


function renderLorebookEditor() {
    const container = document.getElementById('lorebook-entries');
    if (!container) return;
    container.innerHTML = '';
    
    const activeChar = characterDataArray[activeSlotIndex];
    if(!activeChar) return;
    
    const lore = activeChar.lorebook || [];
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

// Global scope helper for the onclick above
window.removeLoreEntry = function(index) {
    const activeChar = characterDataArray[activeSlotIndex];
    if (activeChar && activeChar.lorebook) {
        activeChar.lorebook.splice(index, 1);
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
        container.innerHTML = '<div class="loading">キャラクターが登録されていません。Profiles & Editor からキャラクターをインポートしてください。</div>';
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
    msgDiv.className = 'chat-msg ' + role;
    msgDiv.setAttribute('data-index', msgIndex);
    
    var userSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='%23aaa' d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>";
    
    let portraitSrc = role === 'char' ? '/placeholder.png' : (userConfig.avatar ? userConfig.avatar : userSvg);
    if (role === 'char') {
         const members = getActivePartyMembers();
         const speaker = findMemberBySpeaker(name, members);
         if (speaker && speaker.avatar) {
             portraitSrc = speaker.avatar;
         }
         // Don't fall back to members[0] avatar — use placeholder if speaker is unknown
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
        controls.querySelector('.delete-btn').addEventListener('click', () => deleteMessage(msgIndex));
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

function deleteMessage(index) {
    if (index < 0) return;
    if (confirm('このメッセージを削除しますか？')) {
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
        if (segments.length > 0) {
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
    
    var sendMessage = async function() {
        var text = inputArea.value.trim();
        if(!text) return;
        
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
        systemPrompt = 'Write the next response for the roleplay. You are playing the role of ' + members[0].name + '. Do not break character.\n\n'
            + '[User (Player) Info]\n'
            + 'Name: ' + userConfig.name + '\n'
            + 'Persona: ' + userConfig.persona + '\n\n'
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
            + '例:\n'
            + speakerExample + '\n\n'
            + '[User (Player) Info]\n'
            + 'Name: ' + userConfig.name + '\n'
            + 'Persona: ' + userConfig.persona + '\n\n';

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
    var messages = [
        { role: 'system', content: systemPrompt }
    ];
    
    for (var i = 0; i < chatHistory.length; i++) {
        messages.push(chatHistory[i]);
    }
    
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

init();
