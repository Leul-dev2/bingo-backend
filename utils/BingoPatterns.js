

function checkBingoPattern(card, drawnNumbers) {
  const size = 5;
  const isMatched = (num) => num === 0 || drawnNumbers.has(num);

  // Check rows
  for (let r = 0; r < size; r++) {
    if (card[r].every(isMatched)) return true;
  }

  // Check columns
  for (let c = 0; c < size; c++) {
    let colWin = true;
    for (let r = 0; r < size; r++) {
      if (!isMatched(card[r][c])) {
        colWin = false;
        break;
      }
    }
    if (colWin) return true;
  }

  // Check diagonals
  if ([0, 1, 2, 3, 4].every(i => isMatched(card[i][i]))) return true;
  if ([0, 1, 2, 3, 4].every(i => isMatched(card[i][4 - i]))) return true;

  return false;
}


module.exports = checkBingoPattern;