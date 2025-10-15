import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, updateDoc, collection, query, where, getDocs, runTransaction } from 'firebase/firestore';

// --- Global Setup (Mandatory for Canvas Environment) ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Initialize Firebase (run only once)
let app, db, auth;
try {
    if (Object.keys(firebaseConfig).length > 0) {
        app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
    } else {
        console.error("Firebase configuration is missing.");
    }
} catch (error) {
    console.error("Firebase initialization failed:", error);
}

// --- Constants ---
const PIECE_MAP = {
    'r': '♜', 'n': '♞', 'b': '♝', 'q': '♛', 'k': '♚', 'p': '♟',
    'R': '♖', 'N': '♘', 'B': '♗', 'Q': '♕', 'K': '♔', 'P': '♙',
    '.': '' // Empty square representation in data
};
const INITIAL_BOARD_STRING = 'rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR';
const CS_COINS_PER_STARMAKER_COIN = 400;

// Firestore Paths
const GAME_DOC_PATH = `artifacts/${appId}/public/data/chessGame/current_game`;
const USER_DATA_COLLECTION_PATH = (userId) => `artifacts/${appId}/users/${userId}/userData`;
const LOGIN_COLLECTION_PATH = `artifacts/${appId}/public/data/user_logins`; // For mock CSID login

// Helper Functions (Simplified Move Validation)

/**
 * Checks if a piece is White (uppercase).
 * @param {string} piece 
 */
const isWhite = (piece) => piece === piece.toUpperCase() && piece !== '.';

/**
 * Gets the color of the piece at a given index.
 * @param {string} boardState 
 * @param {number} index 
 */
const getPieceColor = (boardState, index) => {
    const piece = boardState[index];
    if (piece === '.') return null;
    return isWhite(piece) ? 'White' : 'Black';
};

/**
 * Converts 1D index (0-63) to [row, col].
 * @param {number} index 
 * @returns {[number, number]} [row, col] (0-7)
 */
const indexToCoords = (index) => [Math.floor(index / 8), index % 8];

/**
 * Converts [row, col] to 1D index (0-63).
 * @param {number} row 
 * @param {number} col 
 * @returns {number}
 */
const coordsToIndex = (row, col) => row * 8 + col;


/**
 * Simplified move validation. Does NOT check for 'check' or 'checkmate', nor path obstructions for most pieces.
 * Assumes a valid piece/color selection was already made.
 * @param {string} boardState 
 * @param {number} fromIndex 
 * @param {number} toIndex 
 * @returns {boolean}
 */
const isValidMove = (boardState, fromIndex, toIndex) => {
    const [fromR, fromC] = indexToCoords(fromIndex);
    const [toR, toC] = indexToCoords(toIndex);

    const piece = boardState[fromIndex];
    const targetPiece = boardState[toIndex];
    const pieceType = piece.toUpperCase();
    const isMovingWhite = isWhite(piece);

    // Rule 1: Cannot capture your own piece
    if (targetPiece !== '.' && isMovingWhite === isWhite(targetPiece)) {
        return false;
    }

    const dR = toR - fromR;
    const dC = toC - fromC;

    switch (pieceType) {
        case 'P': // Pawn (simplified)
            // Forward movement
            const forwardDir = isMovingWhite ? -1 : 1;
            if (dC === 0) {
                // One step forward
                if (dR === forwardDir && targetPiece === '.') return true;
                // Two steps forward (from starting row)
                if (dR === 2 * forwardDir && targetPiece === '.') {
                    const startingRow = isMovingWhite ? 6 : 1;
                    return fromR === startingRow && boardState[coordsToIndex(fromR + forwardDir, fromC)] === '.';
                }
            }
            // Diagonal capture
            if (Math.abs(dC) === 1 && dR === forwardDir && targetPiece !== '.') {
                return true;
            }
            return false;

        case 'N': // Knight
            return (Math.abs(dR) === 2 && Math.abs(dC) === 1) || (Math.abs(dR) === 1 && Math.abs(dC) === 2);

        case 'B': // Bishop (Simplified: only checks diagonal change, not obstruction)
            return Math.abs(dR) === Math.abs(dC);

        case 'R': // Rook (Simplified: only checks rank/file change, not obstruction)
            return dR === 0 || dC === 0;

        case 'Q': // Queen (Simplified: combination of Rook and Bishop, not obstruction)
            return (dR === 0 || dC === 0) || (Math.abs(dR) === Math.abs(dC));

        case 'K': // King
            return Math.abs(dR) <= 1 && Math.abs(dC) <= 1;

        default:
            return false;
    }
}


// --- Main App Component ---
const App = () => {
    const [gameState, setGameState] = useState({
        boardState: INITIAL_BOARD_STRING,
        turn: 'White',
        player1CSID: '', // White
        player2CSID: '', // Black
        gameStatus: 'Waiting',
        winnerCSID: null,
    });
    const [authUser, setAuthUser] = useState(null);
    const [authReady, setAuthReady] = useState(false);
    const [loggedInCSID, setLoggedInCSID] = useState(null);
    const [isGuest, setIsGuest] = useState(false);
    const [csCoinBalance, setCsCoinBalance] = useState(0);
    const [selectedSquareIndex, setSelectedSquareIndex] = useState(-1);
    const [message, setMessage] = useState('');
    const [isMessageError, setIsMessageError] = useState(false);
    const [modals, setModals] = useState({
        howToPlay: false,
        exchangeCoins: false,
        exchangeAmountSM: 0,
        exchangeAmountCS: 0,
    });
    const [loaders, setLoaders] = useState({});

    // --- Utility Functions for UI ---

    const showMessage = useCallback((msg, isError = false, duration = 5000) => {
        setMessage(msg);
        setIsMessageError(isError);
        setTimeout(() => setMessage(''), duration);
    }, []);

    const showLoader = (key) => setLoaders(prev => ({ ...prev, [key]: true }));
    const hideLoader = (key) => setLoaders(prev => ({ ...prev, [key]: false }));

    const isPlayer = loggedInCSID && (loggedInCSID === gameState.player1CSID || loggedInCSID === gameState.player2CSID);
    const myColor = loggedInCSID === gameState.player1CSID ? 'White' : (loggedInCSID === gameState.player2CSID ? 'Black' : null);

    // --- Firebase Initialization and Game Listener ---

    useEffect(() => {
        if (!auth || !db) return;

        // 1. Auth Setup (Handle custom token or anonymous)
        const setupAuth = async () => {
            try {
                if (initialAuthToken) {
                    await signInWithCustomToken(auth, initialAuthToken);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (error) {
                console.error("Firebase Auth Sign-in Failed:", error);
                // Fallback to anonymous if custom token fails
                await signInAnonymously(auth);
            }
        };
        setupAuth();

        const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
            setAuthUser(user);
            setAuthReady(true);
        });

        // 2. Game State Listener
        const unsubscribeGame = onSnapshot(doc(db, GAME_DOC_PATH), (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                setGameState(prev => {
                    // Check for game completion and handle reset scheduling
                    if (data.gameStatus === 'Finished' && data.winnerCSID && prev.gameStatus !== 'Finished') {
                        handleGameFinished(data.winnerCSID, data.player1CSID, data.player2CSID);
                    }
                    return data;
                });
            } else {
                // Initialize game state if doc doesn't exist
                setDoc(doc(db, GAME_DOC_PATH), {
                    boardState: INITIAL_BOARD_STRING,
                    turn: 'White',
                    player1CSID: '',
                    player2CSID: '',
                    gameStatus: 'Waiting',
                    winnerCSID: null,
                }, { merge: true });
            }
        }, (error) => {
            console.error("Error listening to game state:", error);
            showMessage("Error connecting to game server. Please refresh.", true);
        });

        return () => {
            unsubscribeAuth();
            unsubscribeGame();
        };
    }, []);

    // 3. Wallet Listener (runs when authUser changes and is not a guest)
    useEffect(() => {
        if (!authReady || !authUser || isGuest || !loggedInCSID || !db) {
            setCsCoinBalance(0);
            return;
        }

        const walletRef = doc(db, USER_DATA_COLLECTION_PATH(authUser.uid), 'wallet');
        
        const unsubscribeWallet = onSnapshot(walletRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                setCsCoinBalance(data.csCoinBalance || 0);
            } else {
                // If wallet doesn't exist, initialize it
                setDoc(walletRef, {
                    csid: loggedInCSID,
                    csCoinBalance: 0,
                }, { merge: true });
                setCsCoinBalance(0);
            }
        }, (error) => {
            console.error("Error listening to wallet:", error);
        });

        return () => unsubscribeWallet();
    }, [authReady, authUser, loggedInCSID, isGuest]);


    // --- Game Logic Handlers ---

    const handleLogin = async (csid, password) => {
        if (!db || !authUser) return showMessage("App not ready.", true);
        showLoader('login');
        
        try {
            // Find user in the public login collection
            const q = query(collection(db, LOGIN_COLLECTION_PATH), where("csid", "==", csid));
            const snapshot = await getDocs(q);
            
            let userDocRef;
            
            if (snapshot.empty) {
                // New user - create mock login and initialize private data
                userDocRef = doc(collection(db, LOGIN_COLLECTION_PATH)); // Firestore generates a random ID for the public user info
                await setDoc(userDocRef, { 
                    csid, 
                    passwordHash: password, // Mock hash for simplicity
                    ownerUid: authUser.uid // Link public login record to Firebase Auth user
                });
                
                // Initialize private wallet
                const walletRef = doc(db, USER_DATA_COLLECTION_PATH(authUser.uid), 'wallet');
                await setDoc(walletRef, { csid, csCoinBalance: 0 });

                showMessage(`Welcome, new player ${csid}! Account created.`, false);
            } else {
                // Existing user - validate password
                const userData = snapshot.docs[0].data();
                if (userData.passwordHash !== password) {
                    throw new Error("Invalid password.");
                }
                showMessage(`Welcome back, ${csid}.`, false);
            }

            setLoggedInCSID(csid);
            setIsGuest(false);
        } catch (error) {
            showMessage(`Login Failed: ${error.message}`, true);
        } finally {
            hideLoader('login');
        }
    };

    const handleGuest = () => {
        setIsGuest(true);
        setLoggedInCSID('Guest-' + authUser?.uid.substring(0, 4) || 'Observer');
    };

    const handleJoinGame = async () => {
        if (!loggedInCSID || isGuest) return showMessage("Log in to join the game.", true);
        if (isPlayer) return showMessage("You are already in the game.", true);
        if (gameState.gameStatus === 'Playing') return showMessage("Game is already full and in progress.", true);

        showLoader('join');

        try {
            await runTransaction(db, async (transaction) => {
                const gameDocRef = doc(db, GAME_DOC_PATH);
                const docSnap = await transaction.get(gameDocRef);

                if (!docSnap.exists()) throw new Error("Game state document not found.");

                const current = docSnap.data();
                let { player1CSID, player2CSID, gameStatus } = current;

                if (player1CSID === loggedInCSID || player2CSID === loggedInCSID) {
                    throw new Error("You are already registered in the game.");
                }
                
                if (!player1CSID) {
                    player1CSID = loggedInCSID;
                    showMessage("Joined as Player White (♔).", false);
                } else if (!player2CSID) {
                    player2CSID = loggedInCSID;
                    gameStatus = 'Playing';
                    showMessage("Joined as Player Black (♚). Game starting!", false);
                } else {
                    throw new Error("Game is full.");
                }

                transaction.update(gameDocRef, {
                    player1CSID,
                    player2CSID,
                    gameStatus,
                    winnerCSID: null,
                });
            });
        } catch (error) {
            showMessage(`Failed to join: ${error.message}`, true);
        } finally {
            hideLoader('join');
        }
    };

    const handleLeaveGame = async () => {
        if (!isPlayer) return showMessage("You are not currently playing.", true);

        showLoader('leave');

        try {
            await runTransaction(db, async (transaction) => {
                const gameDocRef = doc(db, GAME_DOC_PATH);
                const docSnap = await transaction.get(gameDocRef);

                if (!docSnap.exists()) throw new Error("Game state document not found.");
                const current = docSnap.data();
                
                let { player1CSID, player2CSID, boardState, turn, gameStatus } = current;

                if (loggedInCSID === player1CSID) {
                    player1CSID = '';
                } else if (loggedInCSID === player2CSID) {
                    player2CSID = '';
                } else {
                    throw new Error("You are not registered in the game.");
                }

                // If only one player leaves, the game resets to waiting
                if (!player1CSID && !player2CSID) {
                    gameStatus = 'Waiting';
                    boardState = INITIAL_BOARD_STRING;
                    turn = 'White';
                } else if (gameStatus === 'Playing') {
                    gameStatus = 'Waiting'; // If one player remains, put it back to waiting
                }

                transaction.update(gameDocRef, {
                    player1CSID,
                    player2CSID,
                    gameStatus,
                    boardState,
                    turn,
                });
            });
            showMessage("Successfully left the game.", false);

        } catch (error) {
            showMessage(`Failed to leave: ${error.message}`, true);
        } finally {
            hideLoader('leave');
        }
    };

    const handleResetGame = async () => {
        showLoader('reset');
        try {
            // Note: In a real app, only admins should be able to hard reset, but following original template.
            await setDoc(doc(db, GAME_DOC_PATH), {
                boardState: INITIAL_BOARD_STRING,
                turn: 'White',
                player1CSID: '',
                player2CSID: '',
                gameStatus: 'Waiting',
                winnerCSID: null,
            });
            showMessage("Game has been reset.", false);
        } catch (error) {
            showMessage(`Error resetting game: ${error.message}`, true);
        } finally {
            hideLoader('reset');
        }
    };

    const handleGameFinished = async (winnerCSID, player1CSID, player2CSID) => {
        // Prevent double handling of finished state
        if (gameState.gameStatus === 'Finished' && gameState.winnerCSID === winnerCSID) return;

        const winnerName = (winnerCSID === player1CSID) ? `Player White (${winnerCSID})` : `Player Black (${winnerCSID})`;
        showMessage(`${winnerName} has won the game! Resetting in 3 seconds...`, false, 3000);

        // Update coins via transaction to ensure atomic operation
        await runTransaction(db, async (transaction) => {
            // Check if player1/2 are authenticated users with wallet docs
            const players = {
                [player1CSID]: authUser.uid, // Assuming logged-in user's UID is used to access wallet
                [player2CSID]: authUser.uid,
            };

            const winAmount = 100;
            const lossAmount = 100;
            
            for (const csid of [player1CSID, player2CSID]) {
                if (csid) {
                    // This is a major simplification. In a true multi-user app, we need the UID associated with the CSID.
                    // For this environment, we rely on the current authUser's UID to access their private wallet.
                    if (loggedInCSID === csid && authUser) { 
                        const walletRef = doc(db, USER_DATA_COLLECTION_PATH(authUser.uid), 'wallet');
                        const walletSnap = await transaction.get(walletRef);
                        const currentBalance = walletSnap.exists() ? walletSnap.data().csCoinBalance : 0;
                        
                        let newBalance = currentBalance;
                        if (csid === winnerCSID) {
                            newBalance += winAmount;
                        } else {
                            newBalance = Math.max(0, newBalance - lossAmount); // Prevent negative balance
                        }
                        transaction.update(walletRef, { csCoinBalance: newBalance });
                    }
                }
            }
        });

        // Schedule the hard reset
        setTimeout(handleResetGame, 3000);
    };

    const handleSquareClick = async (clickedIndex) => {
        if (!db || !authUser) return showMessage("App not ready.", true);
        if (!loggedInCSID || isGuest) return showMessage("Please log in to play.", true);
        if (gameState.gameStatus !== 'Playing' || !isPlayer || myColor !== gameState.turn) {
            return showMessage("It's not your turn or the game is not active.", true);
        }

        const clickedPiece = gameState.boardState[clickedIndex];
        const isClickedPieceMine = getPieceColor(gameState.boardState, clickedIndex) === myColor;

        if (selectedSquareIndex === -1) {
            // Select a piece
            if (clickedPiece === '.') {
                return showMessage("Please select a piece to move.", true);
            }
            if (!isClickedPieceMine) {
                return showMessage("You can only move your own pieces.", true);
            }
            setSelectedSquareIndex(clickedIndex);
        } else {
            // Attempt a move
            if (selectedSquareIndex === clickedIndex) {
                // Deselect
                setSelectedSquareIndex(-1);
                return;
            }

            if (!isValidMove(gameState.boardState, selectedSquareIndex, clickedIndex)) {
                showMessage("Invalid move for that piece (simplified rules).", true);
                setSelectedSquareIndex(-1);
                return;
            }
            
            const fromIndex = selectedSquareIndex;
            const toIndex = clickedIndex;

            showLoader('move');
            showMessage('Making move...', false);

            try {
                await runTransaction(db, async (transaction) => {
                    const gameDocRef = doc(db, GAME_DOC_PATH);
                    const docSnap = await transaction.get(gameDocRef);
                    if (!docSnap.exists()) throw new Error("Game state not found.");

                    const current = docSnap.data();
                    let board = current.boardState.split('');
                    const pieceToMove = board[fromIndex];
                    const targetPiece = board[toIndex];
                    
                    // Final move color check (in case state updated)
                    if (getPieceColor(current.boardState, fromIndex) !== myColor || current.turn !== myColor) {
                        throw new Error("State mismatch: Not your piece or not your turn.");
                    }

                    // Move the piece
                    board[toIndex] = pieceToMove;
                    board[fromIndex] = '.';
                    
                    const newTurn = myColor === 'White' ? 'Black' : 'White';
                    let newGameStatus = 'Playing';
                    let newWinnerCSID = null;
                    
                    // Check for King capture (Winning condition)
                    if (targetPiece.toUpperCase() === 'K') {
                        newGameStatus = 'Finished';
                        newWinnerCSID = loggedInCSID;
                    }

                    transaction.update(gameDocRef, {
                        boardState: board.join(''),
                        turn: newTurn,
                        gameStatus: newGameStatus,
                        winnerCSID: newWinnerCSID,
                    });
                });
                showMessage("Move successful!", false);
            } catch (error) {
                showMessage(`Move failed: ${error.message}`, true);
            } finally {
                hideLoader('move');
                setSelectedSquareIndex(-1);
            }
        }
    };


    // --- Exchange Logic ---

    const handleExchangeClick = (smCoins) => {
        const csRequired = smCoins * CS_COINS_PER_STARMAKER_COIN;
        if (csCoinBalance < csRequired) {
            return showMessage(`You need ${csRequired} CS Coins to exchange for ${smCoins} Starmaker Coins.`, true);
        }
        setModals(prev => ({
            ...prev,
            exchangeCoins: true,
            exchangeAmountSM: smCoins,
            exchangeAmountCS: csRequired,
        }));
    };

    const handleConfirmExchange = async () => {
        const sid = document.getElementById('starmakerSidInput').value.trim();
        if (!sid) return showMessage("Please enter your Starmaker SID/Username.", true);
        
        showLoader('exchange');
        
        try {
            const csRequired = modals.exchangeAmountCS;
            if (csCoinBalance < csRequired) {
                throw new Error("Insufficient CS Coins for this exchange.");
            }

            // Perform transaction to deduct coins
            await runTransaction(db, async (transaction) => {
                const walletRef = doc(db, USER_DATA_COLLECTION_PATH(authUser.uid), 'wallet');
                const walletSnap = await transaction.get(walletRef);

                if (!walletSnap.exists()) throw new Error("Wallet not found.");
                
                const currentBalance = walletSnap.data().csCoinBalance;
                if (currentBalance < csRequired) throw new Error("Insufficient funds (race condition check).");

                transaction.update(walletRef, { csCoinBalance: currentBalance - csRequired });
            });

            // Log the exchange request (simulating transfer to Cansing admin)
            const exchangeLogRef = doc(collection(db, `artifacts/${appId}/public/data/exchange_requests`));
            await setDoc(exchangeLogRef, {
                csid: loggedInCSID,
                starmakerSID: sid,
                smCoins: modals.exchangeAmountSM,
                csCoinsDeducted: csRequired,
                timestamp: new Date().toISOString(),
                status: 'Requested',
            });

            showMessage(`Exchange successful! ${csRequired} CS Coins deducted. Your ${modals.exchangeAmountSM} Starmaker Coins will be transferred to SID ${sid} shortly.`, false);
            setModals(prev => ({ ...prev, exchangeCoins: false }));
        } catch (error) {
            showMessage(`Exchange failed: ${error.message}`, true);
        } finally {
            hideLoader('exchange');
        }
    };

    // --- Component Rendering ---

    const renderBoard = useMemo(() => {
        return gameState.boardState.split('').map((piece, index) => {
            const row = Math.floor(index / 8);
            const col = index % 8;
            const isWhiteSquare = (row + col) % 2 === 0;
            const isSelected = index === selectedSquareIndex;
            
            let classes = isWhiteSquare ? 'bg-[#f0d9b5]' : 'bg-[#b58863]';
            let pieceColor = '';

            if (piece === piece.toUpperCase() && piece !== '.') {
                pieceColor = 'text-white';
            } else if (piece === piece.toLowerCase() && piece !== '.') {
                pieceColor = 'text-[#333]';
            }

            if (isSelected) {
                classes = 'bg-lime-400 shadow-[inset_0_0_0_3px_#166534]';
            } else if (isPlayer && myColor === gameState.turn && selectedSquareIndex !== -1) {
                // Simplified highlight for potential moves (not fully accurate, just visual)
                if (isValidMove(gameState.boardState, selectedSquareIndex, index)) {
                    classes = 'bg-amber-400 shadow-[inset_0_0_0_3px_#b45309]';
                }
            }

            return (
                <div
                    key={index}
                    data-index={index}
                    className={`square flex items-center justify-center text-3xl font-semibold cursor-pointer select-none ${classes} ${pieceColor}`}
                    onClick={() => handleSquareClick(index)}
                >
                    {PIECE_MAP[piece]}
                </div>
            );
        });
    }, [gameState.boardState, selectedSquareIndex, isPlayer, myColor, gameState.turn, handleSquareClick]);

    const LoginSection = (
        <div id="login-section" className="bg-white p-8 rounded-xl shadow-2xl w-full max-w-md text-center border border-gray-100">
            <h1 className="text-3xl font-extrabold mb-4 text-gray-900">Cansing Chess Event</h1>
            <p className="text-gray-600 mb-6 font-medium">AUGUST - 2025</p>
            <p className="text-gray-500 mb-4 text-sm">Login with your CSID (Creates account if new) or continue as an observer.</p>

            <div className="mb-4">
                <input type="text" id="csid" placeholder="CSID" className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500 shadow-sm" />
            </div>
            <div className="mb-6">
                <input type="password" id="password" placeholder="Password" className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500 shadow-sm" />
            </div>

            <button
                className="btn-purple w-full mb-4 flex items-center justify-center"
                disabled={loaders.login}
                onClick={() => handleLogin(document.getElementById('csid').value, document.getElementById('password').value)}
            >
                Login
                {loaders.login && <span className="loader ml-3"></span>}
            </button>
            <button className="btn-gray w-full" onClick={handleGuest}>
                <b>Continue as Guest</b>
            </button>
            <p className="mt-6 text-xs text-gray-400">
                Any enquiries or complaints? Please contact Cansing family on starmaker. Family ID: 668332
            </p>
        </div>
    );

    const GameSection = (
        <div id="game-section" className="w-full max-w-4xl flex flex-col items-center mt-8 p-6 bg-white rounded-xl shadow-2xl border border-gray-100">
            <h2 id="gameTitle" className="text-2xl font-bold mb-2 text-gray-800">Chess Game - CanSing (668332)</h2>
            <p id="loggedInAs" className="text-purple-600 mb-4 font-semibold italic">{isGuest ? `Viewing as: Guest` : `Logged in as: ${loggedInCSID}`}</p>
            
            <div className="flex flex-col sm:flex-row justify-center w-full mb-6 text-xl font-semibold text-gray-800 gap-4 sm:gap-12">
                <p id="playerWhiteInfo" className={`p-2 rounded-lg transition duration-200 ${gameState.turn === 'White' && gameState.gameStatus === 'Playing' ? 'active-player-highlight' : 'bg-gray-100'}`}>
                    Player White (♔): <span className="text-blue-700">{gameState.player1CSID || 'Waiting...'}</span>
                </p>
                <p id="playerBlackInfo" className={`p-2 rounded-lg transition duration-200 ${gameState.turn === 'Black' && gameState.gameStatus === 'Playing' ? 'active-player-highlight' : 'bg-gray-100'}`}>
                    Player Black (♚): <span className="text-blue-700">{gameState.player2CSID || 'Waiting...'}</span>
                </p>
            </div>

            <p id="turnInfo" className="text-xl font-extrabold mb-6 text-gray-800">
                {gameState.gameStatus === 'Playing' ? `Turn: ${gameState.turn}` : `Status: ${gameState.gameStatus}`}
            </p>
            
            <div className="chess-board" id="chessBoard">
                {renderBoard}
            </div>

            <div id="game-controls" className="mt-8 flex flex-wrap justify-center gap-4 sm:gap-6 w-full max-w-lg">
                <button 
                    className="btn-green flex items-center" 
                    disabled={isGuest || isPlayer || gameState.gameStatus === 'Playing' || loaders.join}
                    onClick={handleJoinGame}
                >
                    {loaders.join ? 'Joining...' : (isPlayer ? 'In Game' : (gameState.gameStatus === 'Playing' ? 'Game Full' : 'Join Game'))}
                    {loaders.join && <span className="loader ml-3"></span>}
                </button>
                <button 
                    className="btn-gray flex items-center" 
                    disabled={isGuest || !isPlayer || loaders.leave}
                    onClick={handleLeaveGame}
                >
                    {loaders.leave ? 'Leaving...' : (isPlayer ? 'Leave Game' : 'Not In Game')}
                    {loaders.leave && <span className="loader ml-3"></span>}
                </button>
                <button 
                    className="btn-red flex items-center" 
                    disabled={isGuest || loaders.reset}
                    onClick={handleResetGame}
                >
                    Reset Game
                    {loaders.reset && <span className="loader ml-3"></span>}
                </button>
                <button className="btn-blue" onClick={() => setModals(prev => ({ ...prev, howToPlay: true }))}>How to Play</button>
            </div>

            {/* Wallet Section */}
            {!isGuest && (
                <div id="wallet-section" className="w-full mt-8 p-6 bg-blue-50 rounded-xl shadow-inner text-center">
                    <h3 className="text-xl font-bold text-blue-800 mb-4">Your Wallet</h3>
                    <p className="text-3xl font-black text-gray-900 mb-6">CS Coins: <span className="text-green-600">{csCoinBalance}</span></p>

                    <h4 className="text-lg font-semibold text-gray-800 mb-3">Exchange CS Coins for Starmaker Coins:</h4>
                    <p className="text-sm text-gray-600 mb-4">
                        Rate: 400 CS Coins = 1 Starmaker Coin.
                    </p>
                    <div className="flex flex-wrap justify-center gap-3">
                        {[42, 84, 429, 871].map(smCoins => (
                            <button 
                                key={smCoins}
                                className="btn-orange text-sm px-4 py-2" 
                                disabled={csCoinBalance < (smCoins * CS_COINS_PER_STARMAKER_COIN)}
                                onClick={() => handleExchangeClick(smCoins)}
                            >
                                {smCoins} SM Coins ({smCoins * CS_COINS_PER_STARMAKER_COIN} CS)
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {message && (
                <p className={`mt-4 text-center font-bold text-lg p-2 rounded-lg ${isMessageError ? 'text-red-700 bg-red-100' : 'text-green-700 bg-green-100'}`}>
                    {message}
                </p>
            )}
        </div>
    );

    const HowToPlayModal = (
        <div className={`modal-overlay ${modals.howToPlay ? '' : 'hidden'}`}>
            <div className="modal-content">
                <button className="modal-close-btn" onClick={() => setModals(prev => ({ ...prev, howToPlay: false }))}>&times;</button>
                <h3 className="text-2xl font-bold mb-4 text-gray-900">How to Play Chess</h3>
                <div className="text-gray-700 leading-relaxed">
                    <p className="mb-3">Welcome to Multiplayer Chess! Here's how to play:</p>
                    <ol className="list-decimal list-inside space-y-2">
                        <li><strong>Login or Guest:</strong> Log in with a CSID (account created if new). Join as a guest to observe.</li>
                        <li><strong>Join Game:</strong> If logged in, click "Join Game." First player is White (♔), second is Black (♚).</li>
                        <li><strong>Make a Move:</strong> Click your piece, then click the target square.</li>
                        <li><strong>Simplified Rules:</strong> Basic movement validation only (Pawns move/capture, Knight L-shape, R/B/Q/K standard). **No checks for path obstruction, check/checkmate, castling, en passant, or pawn promotion.**</li>
                        <li><strong>Winning:</strong> The game ends when one player captures the opponent's **King**. The winner receives **100 CS Coins**, the loser loses **100 CS Coins**.</li>
                        <li><strong>Observe:</strong> Guests and non-participating players watch the game in real-time.</li>
                        <li><strong>Coin Exchange:</strong> Use the wallet section to exchange your CS Coins for Starmaker Coins at a rate of **400 CS Coins = 1 Starmaker Coin**.</li>
                    </ol>
                    <p className="mt-4">Enjoy the game!</p>
                </div>
            </div>
        </div>
    );

    const ExchangeCoinsModal = (
        <div className={`modal-overlay ${modals.exchangeCoins ? '' : 'hidden'}`}>
            <div className="modal-content">
                <button className="modal-close-btn" onClick={() => setModals(prev => ({ ...prev, exchangeCoins: false }))}>&times;</button>
                <h3 className="text-2xl font-bold mb-4 text-gray-900">Confirm Exchange</h3>
                <p className="text-gray-700 mb-4">Exchange Rate: <strong>{CS_COINS_PER_STARMAKER_COIN} CS Coins = 1 Starmaker Coin</strong></p>
                <p className="text-lg font-semibold text-blue-700 mb-6">
                    You are exchanging <strong>{modals.exchangeAmountSM} Starmaker Coins</strong> for <strong>{modals.exchangeAmountCS} CS Coins</strong>.
                </p>

                <div className="mb-4">
                    <label htmlFor="starmakerSidInput" className="block text-gray-700 text-sm font-bold mb-2">Enter your Starmaker SID/Username:</label>
                    <input type="text" id="starmakerSidInput" placeholder="Your Starmaker ID" className="w-full p-3 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 shadow-sm" />
                </div>
                <button 
                    className="btn-green w-full flex items-center justify-center" 
                    disabled={loaders.exchange}
                    onClick={handleConfirmExchange}
                >
                    Confirm Exchange
                    {loaders.exchange && <span className="loader ml-3"></span>}
                </button>
                <p id="exchangeMessage" className={`mt-4 text-red-600 font-medium ${loaders.exchange ? 'hidden' : ''}`}></p>
            </div>
        </div>
    );

    if (!authReady) {
        return (
            <div className="p-10 text-center text-xl font-semibold text-gray-700">
                Loading Application... <span className="loader"></span>
            </div>
        );
    }

    return (
        <div className="p-4 sm:p-6 flex flex-col items-center min-h-screen bg-gray-50">
            {!loggedInCSID && !isGuest ? LoginSection : GameSection}
            {HowToPlayModal}
            {ExchangeCoinsModal}
        </div>
    );
};

export default App;
