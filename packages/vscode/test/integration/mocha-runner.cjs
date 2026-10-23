// @ts-check
/**
 * Runs the integration test file UPFLY_TESTS names with Mocha inside the extension host, for a
 * VS Code started without the test CLI.
 */
const Mocha = require('mocha');

exports.run = () =>
  new Promise((resolve, reject) => {
    const mocha = new Mocha({ ui: 'bdd', timeout: 180_000, color: false });
    mocha.addFile(String(process.env.UPFLY_TESTS));
    mocha.run((failures) => {
      if (failures === 0) resolve(undefined);
      else reject(new Error(`${failures} integration tests failed`));
    });
  });
