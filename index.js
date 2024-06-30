const http = require("http");
const https = require("https");
const fs = require("fs");
const { URL } = require("url");
const crypto = require("crypto");

// Load Google API credentials from a JSON file
const credentials = JSON.parse(fs.readFileSync("credentials.json"));

const { client_secret, client_id } = credentials.web;
const port = 3000;
const all_sessions = [];
const server = http.createServer();

server.on("listening", listen_handler);
server.listen(port);

function listen_handler() {
	console.log(`Now Listening on Port ${port}`);
}
server.on("request", request_handler);

function request_handler(req, res) {
	console.log(`New Request from ${req.socket.remoteAddress} for ${req.url}`);
	const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

	if (req.url === "/") {
		const form = fs.createReadStream("index.html");
		res.writeHead(200, { "Content-Type": "text/html" });
		form.pipe(res);
	} else if (req.url.startsWith("/searchVerse")) {
		const user_input = parsedUrl.searchParams;
		const keywords = user_input.get("keywords");
		console.log("Keywords: " + keywords);

		if (keywords == null) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Search parameter is required" }));
			return;
		}

		fetchBible(keywords, (err, bibleData) => {
			if (err) {
				console.error("Error fetching Bible data:", err);
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Internal server error" }));
			} else {
				const state = crypto.randomBytes(20).toString("hex");
				const extractedVerses = extractVerses(bibleData); // Extracted bible verses here
				all_sessions.push({ keywords, extractedVerses, state }); // Save the session data
				redirect_to_google(state, res); // Redirect for authentication to get Code
			}
		});
	} else if (req.url.startsWith("/receive_code")) {
		const user_input = parsedUrl.searchParams;
		const code = user_input.get("code");
		const state = user_input.get("state");
		let session = all_sessions.find((session) => session.state === state);
		if (!code || !state || !session) {
			not_found(res);
			return;
		}
		console.log(`Session Data: ${JSON.stringify(session)}`);
		send_access_token_request(code, session, res);

		// Logic here is after we obtain the access token, we then make call to the google api to create the document with the verses that we obtain from the previous
		// extractVerse function. And finally the user should be shown with the page that says, search results are successfully saved.
	} else {
		not_found(res);
	}
}

function fetchBible(keywords, callback) {
	const bibleAPIKey = "";
	const apiUrl = `https://api.scripture.api.bible/v1/bibles/06125adad2d5898a-01/search?query=${keywords}&sort=relevance`;

	const options = {
		method: "GET",
		headers: {
			"api-key": bibleAPIKey,
			"Content-Type": "application/json",
		},
	};

	const bibleRequest = https.get(apiUrl, options, (response) => {
		let data = "";

		response.on("data", (chunk) => {
			data += chunk;
		});

		response.on("end", () => {
			try {
				const jsonData = JSON.parse(data);
				callback(null, jsonData);
			} catch (error) {
				callback(error, null);
			}
		});
	});

	bibleRequest.on("error", (error) => {
		callback(error, null);
	});

	bibleRequest.end();
}

function extractVerses(bibleData) {
	if (
		!bibleData ||
		!bibleData.data ||
		!bibleData.data.verses ||
		bibleData.data.verses.length === 0
	) {
		console.log("No verses found.");
		return [];
	}

	return bibleData.data.verses.map((verse) => ({
		reference: verse.reference,
		text: verse.text,
	}));
}

function redirect_to_google(state, res) {
	const authorization_endpoint =
		"https://accounts.google.com/o/oauth2/v2/auth";
	const client_id =
		"395930951101-s177h436v1737qo4mkpraa020c8bgi70.apps.googleusercontent.com";
	const redirect_uri = "http://localhost:3000/receive_code";
	const scope = "https://www.googleapis.com/auth/drive.file";

	const queryParams = new URLSearchParams({
		client_id,
		redirect_uri,
		scope,
		state,
		response_type: "code",
		access_type: "offline",
	}).toString();

	res.writeHead(302, {
		Location: `${authorization_endpoint}?${queryParams}`,
	}).end();
}

function send_access_token_request(code, session, res) {
	const token_endpoint = "https://oauth2.googleapis.com/token";
	const post_data = new URLSearchParams({
		client_id,
		client_secret,
		code,
		redirect_uri: "http://localhost:3000/receive_code",
		grant_type: "authorization_code",
	}).toString();

	const options = {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
	};

	const tokenRequest = https.request(
		token_endpoint,
		options,
		(token_stream) =>
			process_stream(token_stream, receive_access_token, session, res)
	);

	tokenRequest.on("error", (error) => {
		console.error("Token request error:", error);
	});

	tokenRequest.end(post_data);
}

function process_stream(stream, callback, ...args) {
	let body = "";
	stream.on("data", (chunk) => (body += chunk));
	stream.on("end", () => callback(body, ...args));
}

function receive_access_token(body, session, res) {
	const { access_token } = JSON.parse(body);
	console.log(`Access Token: ${access_token}`);

	createDoc(access_token, session.keywords, (docId, error) => {
		if (error) {
			console.error("Error creating Google Docs file:", error);
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Internal server error" }));
			return;
		}
		createGoogleDoc(
			docId,
			session.extractedVerses,
			access_token,
			(updateResponse, error) => {
				if (error) {
					console.error("Error updating Google Docs file:", error);
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Internal server error" }));
					return;
				}

				console.log("Updated Google Doc:", updateResponse);
				// Redirect to the main page after successful document creation and update
				res.writeHead(302, { Location: "http://localhost:3000" });
				res.end();
			}
		);
	});
}

function createDoc(access_token, keywords, callback) {
	const apiUrl = "https://docs.googleapis.com/v1/documents";
	const requestBody = {
		title: `Extracted Verses - ${keywords}`, // Include keywords in the title
	};
	const options = {
		method: "POST",
		headers: {
			Authorization: `Bearer ${access_token}`,
			"Content-Type": "application/json",
		},
	};

	const docRequest = https.request(apiUrl, options, (doc_stream) => {
		let body = "";
		doc_stream.on("data", (chunk) => (body += chunk));
		doc_stream.on("end", () => {
			const responseObj = JSON.parse(body);
			const docId = responseObj.documentId;
			callback(docId); // Pass the document ID to the callback function
		});
	});

	docRequest.on("error", (error) => {
		console.error("Error creating Google Docs file:", error);
		callback(null, error); // Pass error to the callback function
	});

	docRequest.write(JSON.stringify(requestBody));
	docRequest.end();
}

// Function to update the Google Doc using its DocID
function createGoogleDoc(docId, extractedVerses, access_token, callback) {
	const apiUrl = `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`;
	console.log("Extracted Verses: " + JSON.stringify(extractedVerses));
	const content = extractedVerses
		.map((verse) => `${verse.reference}: ${verse.text}`)
		.join("\n");
	console.log("Content: " + content);
	const requestBody = {
		requests: [
			{
				insertText: {
					text: content,
					endOfSegmentLocation: {},
				},
			},
		],
	};
	const options = {
		method: "POST",
		headers: {
			Authorization: `Bearer ${access_token}`,
			"Content-Type": "application/json",
		},
	};

	const docRequest = https.request(apiUrl, options, (doc_stream) => {
		let body = "";
		doc_stream.on("data", (chunk) => (body += chunk));
		doc_stream.on("end", () => {
			callback(body); // Pass the response body to the callback function
		});
	});

	docRequest.on("error", (error) => {
		console.error("Error updating Google Docs file:", error);
		callback(null, error); // Pass error to the callback function
	});

	docRequest.write(JSON.stringify(requestBody));
	docRequest.end();
}

function not_found(res) {
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("404 - Not Found");
}
