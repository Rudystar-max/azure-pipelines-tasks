import path = require('path');
import sign = require('ios-signing-common/ios-signing-common');
import secureFilesCommon = require('securefiles-common/securefiles-common');
import tl = require('vsts-task-lib/task');
import os = require('os');

async function run() {
    let secureFileId: string;
    let secureFileHelpers: secureFilesCommon.SecureFileHelpers;

    try {
        tl.setResourcePath(path.join(__dirname, 'task.json'));

        // Check platform is macOS since demands are not evaluated on Hosted pools
        if (os.platform() !== 'darwin') {
            throw new Error(tl.loc('InstallRequiresMac'));
        }

        // download decrypted contents
        secureFileId = tl.getInput('certSecureFile', true);
        secureFileHelpers = new secureFilesCommon.SecureFileHelpers();
        let certPath: string = await secureFileHelpers.downloadSecureFile(secureFileId);

        let certPwd: string = tl.getInput('certPwd');

        // get the P12 details - SHA1 hash, common name (CN) and expiration.
        const p12Properties = await sign.getP12Properties(certPath, certPwd);
        let commonName: string = p12Properties.commonName;
        const fingerprint: string = p12Properties.fingerprint,
            notBefore: Date = p12Properties.notBefore,
            notAfter: Date = p12Properties.notAfter;

        // give user an option to override the CN as a workaround if we can't parse the certificate's subject.
        const commonNameOverride: string = tl.getInput('certSigningIdentity', false);
        if (commonNameOverride) {
            commonName = commonNameOverride;
        }

        if (!fingerprint || !commonName) {
            throw new Error(tl.loc('INVALID_P12'));
        }
        tl.setTaskVariable('APPLE_CERTIFICATE_SHA1HASH', fingerprint);

        // set the signing identity output variable.
        tl.setVariable('signingIdentity', commonName);

        // Warn if the certificate is not yet valid or expired. If the dates are undefined or invalid, the comparisons below will return false.
        const now: Date = new Date();
        if (notBefore > now) {
            throw new Error(tl.loc('CertNotValidYetError', commonName, fingerprint, notBefore));
        }
        if (notAfter < now) {
            throw new Error(tl.loc('CertExpiredError', commonName, fingerprint, notAfter));
        }

        // install the certificate in specified keychain, keychain is created if required
        let keychain: string = tl.getInput('keychain');
        let keychainPwd: string = tl.getInput('keychainPassword');
        let keychainPath: string;
        if (keychain === 'temp') {
            keychainPath = sign.getTempKeychainPath();
            // generate a keychain password for the temporary keychain
            // overriding any value we may have read because keychainPassword is hidden in the designer for 'temp'.
            keychainPwd = Math.random().toString(36);
            tl.setSecret(keychainPwd);
        } else if (keychain === 'default') {
            keychainPath = await sign.getDefaultKeychainPath();
        } else if (keychain === 'custom') {
            keychainPath = tl.getInput('customKeychainPath', true);
        }
        tl.setTaskVariable('APPLE_CERTIFICATE_KEYCHAIN', keychainPath);

        await sign.installCertInTemporaryKeychain(keychainPath, keychainPwd, certPath, certPwd, true);

        // set the keychain output variable.
        tl.setVariable('keychainPath', keychainPath);

        // Set the legacy variables that doesn't use the task's refName, unlike our output variables.
        // If there are multiple InstallAppleCertificate tasks, the last one wins.
        tl.setVariable('APPLE_CERTIFICATE_SIGNING_IDENTITY', commonName);
        tl.setVariable('APPLE_CERTIFICATE_KEYCHAIN', keychainPath);
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err);
    } finally {
        // delete certificate from temp location after installing
        if (secureFileId && secureFileHelpers) {
            secureFileHelpers.deleteSecureFile(secureFileId);
        }
    }
}

run();
