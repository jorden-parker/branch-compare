export function createTokenStore(configuredToken = { value: null, source: 'none' }) {
  let enteredValue = null;
  return {
    read: () => enteredValue ?? configuredToken.value,
    describeSource: () => (enteredValue ? 'entered' : configuredToken.source),
    enter(value) {
      enteredValue = value;
    },
    clear() {
      enteredValue = null;
    },
  };
}
