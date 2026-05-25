const demoButton = document.getElementById('demoButton');
const demoOutput = document.getElementById('demoOutput');

if (demoButton && demoOutput) {
  demoButton.addEventListener('click', () => {
    demoOutput.textContent = 'The Depth HTML workspace is ready! Review the docs and extend this starter project.';
  });
}
