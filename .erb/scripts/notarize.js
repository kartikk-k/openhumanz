const { notarize } = require('@electron/notarize');
const { build } = require('../../package.json');

exports.default = async function notarizeMacos(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    return;
  }

  // Check if notarization is enabled
  if (!build.mac || !build.mac.notarize) {
    console.log('Skipping notarization - not configured in package.json');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appName}...`);
  console.log(`App path: ${appPath}`);
  console.log(`App Bundle ID: ${build.appId}`);

  try {
    // Use ONLY keychain profile for notarization
    await notarize({
      tool: 'notarytool',
      appBundleId: build.appId,
      appPath,
      keychainProfile: 'notarization-profile',
    });

    console.log('✅ Notarization successful!');
  } catch (error) {
    console.error('❌ Notarization failed:', error);
    throw error;
  }
};
