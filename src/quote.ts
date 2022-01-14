declare global {
    var quote: Quote; // eslint-disable-line
    var q: Quote; // eslint-disable-line
}

type Quote = typeof quote;

export function registerQuote() {
    global.q = quote;
    global.quote = quote;
}

function quote(strings: string[], ...values: unknown[]) {
    let newStr = "__quote__:";
  
    for (let i = 0; i < strings.length; i++) {
        if (i > 0) {
            newStr += values[i - 1];
        }
        newStr += strings[i];
    }
  
    return newStr;
}
