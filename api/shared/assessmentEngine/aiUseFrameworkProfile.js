'use strict';

const { createSmallBusinessCheck } = require('./smallBusinessCheckProfile');

const groups = [
    ["ai_tools", "Choosing AI tools", [
        ["approved","Approved tools","Can staff find a list of AI tools they may use for work?","A clear list removes guesswork.","The current list on the staff page.","List each allowed tool and the work it may be used for."],
        ["new_tool","New tools","Does someone check a new AI tool before staff use it for work?","Tools can handle the same information differently.","A decision note for the last tool considered.","Name a reviewer and record whether the tool is allowed."]
    ]],
    ["ai_data", "Sharing information", [
        ["inputs","Information limits","Do staff know what they must leave out of AI prompts and uploads?","Customer details can slip into a pasted email or file.","A short guide showing what to leave out.","Write an allowed example and a prohibited example using made-up details."],
        ["settings","Tool settings","Has someone checked how each approved AI tool uses what staff enter?","The tool may keep or reuse prompts.","A dated note of the settings checked.","Review the settings and write down what information staff may enter."],
        ["mistake","Accidental sharing","Do staff know who to tell if they put private information into an AI tool by mistake?","Quick reporting gives you a chance to limit the impact.","The contact named in staff guidance.","Name a contact and rehearse reporting a fictional mistake."]
    ]],
    ["ai_staff", "Guidance for staff", [
        ["induction","Getting started","Do new starters learn the rules before using AI for work?","A new starter may not know your local rules.","An induction checklist with the AI guidance on it.","Add the guidance to induction and name who explains it."],
        ["practice","Practising the rules","Have staff practised deciding when not to use AI?","Examples help people recognise a tricky case.","Notes from a short team exercise.","Discuss a fictional customer request and record the safer choice."]
    ]],
    ["ai_review", "Checking the result", [
        ["facts","Checking facts","Does a person check AI-generated facts against a reliable source before relying on them?","A confident answer can still be wrong.","An example with the source used for checking.","Pick one recent draft and check its key claims against the original source."],
        ["outbound","Customer messages","Does someone read and approve AI-drafted customer messages before they go out?","Your business is responsible for what the message says.","A review step in the customer email process.","Choose who checks accuracy and tone before a message is sent."],
        ["decisions","Decisions about people","Does a named person make the final call when AI helps with a decision about someone?","A tool may miss facts that matter to the person affected.","A decision record naming the reviewer.","Write down who can override the suggestion and how they record the decision."]
    ]]
];

function createAiUseFrameworkProfile() {
    return createSmallBusinessCheck({ id: 'ai_use', title: 'AI use check',
        description: 'Check how your team chooses AI tools, protects information and reviews the results.',
        file: 'aiUseFrameworkProfile.js', groups }, 'f3a5ae75ef87d070603dd28dbf406803d6d0d7a1a2ccb9457c9fac61f6b8a45a');
}

module.exports = { createAiUseFrameworkProfile };
