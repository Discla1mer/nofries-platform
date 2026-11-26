'use strict';

const { createSmallBusinessCheck } = require('./smallBusinessCheckProfile');

const groups = [
    ["it_licences", "Licences and renewals", [
        ["licences","Licence list","Can you see which software licences you pay for and who uses them?","Unused seats can keep costing money.","A licence list with seat counts and owners.","Compare a recent invoice with the people using the software."],
        ["renewal","Renewals","Does someone review the number of seats you need before each renewal?","Once a contract renews it may be too late to reduce seats.","A reminder before the supplier notice deadline.","Assign a renewal owner and book the next seat review."]
    ]],
    ["it_devices", "Device life", [
        ["device_age","Device age","Do you know how old each work computer is?","Without an inventory it is hard to plan replacements.","A device list showing purchase years.","Add the purchase year or estimated age to your device list."],
        ["replacement","Replacement decisions","Have you identified devices that need replacing before support ends?","An older device may stop receiving important fixes.","A replacement plan with support end dates.","Check the oldest device and record a replacement owner and target date."]
    ]],
    ["it_backups", "Backups of online services", [
        ["saas_backup","Online service backups","Do you know how to recover business records deleted from each online service you rely on?","A provider keeping its service running is not the same as restoring your files.","A recovery note for each key service.","List your key services and record what is backed up and for how long."],
        ["restore","Testing recovery","Have you tested restoring a file or record from an online service backup?","A test shows whether the recovered item is usable.","A dated restore-test result.","Restore a harmless test item and record whether it opened correctly."]
    ]],
    ["it_access", "Sign-in protection", [
        ["mfa","Extra sign-in checks","Do you know which work accounts have multi-factor authentication (MFA) turned on?","Coverage can vary between services and staff.","An MFA coverage report or account checklist.","Check each important service and list accounts missing the extra sign-in check."],
        ["admin_mfa","Administrator accounts","Is MFA required for every administrator account in your key services?","Administrators can change settings for the whole business.","The sign-in policy for administrator accounts.","Check the administrator list against the policy and record any gaps."]
    ]],
    ["it_support", "Getting help", [
        ["support","Support contacts","Do staff know who to contact when a key system stops working?","An up-to-date contact saves time during an interruption.","A support list staff can find even if email is down.","List a contact and a backup contact for each key system."],
        ["coverage","Support arrangements","Do you know what help your IT support agreement covers?","Finding out after a breakdown can delay repairs.","A summary of support hours and exclusions.","Record the hours, covered services and route for urgent help."]
    ]]
];

function createItOptimisationFrameworkProfile() {
    return createSmallBusinessCheck({ id: 'it_optimisation', title: 'IT optimisation check',
        description: 'Check how your business looks after software, devices, online records and support.',
        file: 'itOptimisationFrameworkProfile.js', groups }, '3690d7be0e6d80eca7473856e91ac4634d9346c9625b9b0e524da0cf8a0a2d14');
}

module.exports = { createItOptimisationFrameworkProfile };
