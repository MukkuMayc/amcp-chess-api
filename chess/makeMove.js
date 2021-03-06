import * as dynamoDbLib from '../libs/dynamodb-lib';
import { success, failure, userFailure } from '../libs/response-lib';
import AWS from "aws-sdk";
import Chess from 'chess.js';

async function getRoomConnections(gameId) {
  let params = {
    TableName: process.env.WebSocketConnectionsTableName,
    ProjectionExpression: "connectionId",
    FilterExpression: "gameId = :gameId",
    ExpressionAttributeValues: {
      ":gameId": gameId,
    }
  };

  let result;
  try {
    result = await dynamoDbLib.call("scan", params);
  }
  catch(e) {
    console.log("Error while scanning WebSocketConnections");
    throw {text: "Error while scanning WebSocketConnections", error: e};
  }
  return result;
}

async function notifyMove(connectionId, whoseMove, move, api) {
  await api.postToConnection({
    ConnectionId: connectionId,
    Data: JSON.stringify({
      action: "move",
      text: whoseMove ? "Player 1" : "Player 2",
      move: move,
    }),
  }).promise();
}

async function notifyGameOver(connectionId, playersStatus, reason, move, api) {
  await api.postToConnection({
    ConnectionId: connectionId,
    Data: JSON.stringify({
      action: "gameOver",
      text: playersStatus + " : " + reason,
      move: move,
    }),
  }).promise();
}

async function propagateMove(event, gameId, whoseMove, move) {
  const connections = await getRoomConnections(gameId);

  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage,
  });

  try {
    for (let i = 0; i < connections.Items.length; ++i) {
      await notifyMove(connections.Items[i].connectionId, whoseMove, move, apigwManagementApi);
    }
  }
  catch(e) {
    console.log("Error while sending message:", e);
    throw {text: "Error while sending message:", error: e};
  }
}

async function propagateGameOver(event, gameId, playersStatus, reason, move) {
  const connections = await getRoomConnections(gameId);

  const apigwManagementApi = new AWS.ApiGatewayManagementApi({
    apiVersion: '2018-11-29',
    endpoint: event.requestContext.domainName + '/' + event.requestContext.stage,
  });

  try {
    for (let i = 0; i < connections.Items.length; ++i) {
      await notifyGameOver(connections.Items[i].connectionId, playersStatus, reason, move, apigwManagementApi);
    }
  }
  catch(e) {
    console.log("Error while sending message:", e);
    throw {text: "Error while sending message:", error: e};
  }
}

export async function main(event, context) {
  console.log("event:", event);
  let body = JSON.parse(event.body);
  let params = {
    TableName: process.env.RoomsTableName,
    Key: {
      gameId: body.gameId,
    }
  };
  try {
    const result = await dynamoDbLib.call("get", params);
    if (result.Item) {
      let chess = new Chess();
      chess.load_pgn(result.Item.notation || '');
      let idCurr = (chess.turn() == 'w' ? result.Item.connectionId1 : result.Item.connectionId2);

      if (event.requestContext.connectionId != idCurr) { // check if it's our move
        return userFailure({text: "Not your move"});
      }

      if (!chess.move(body.move, {sloppy: true})) { // trying to make move
        return userFailure({text: "Impossible move"});
      }

      let params = {
        TableName: process.env.RoomsTableName,
        UpdateExpression: "SET notation = :notation",
        ExpressionAttributeValues: {
          ":notation": chess.pgn(),
        },
        Key: {
          gameId: body.gameId,
        }
      };
      await dynamoDbLib.call("update", params);

      if (chess.game_over()) { // check if game is over
        let reason;
        let isDraw = true;
        if (chess.in_checkmate()) {
          reason = "checkmate";
          isDraw = false;
        }
        else if (chess.in_draw()) {
          reason = "draw";
        }
        else if (chess.in_stalemate()) {
          reason = "stalemate";
        }
        else if (chess.in_threefold_repetition()) {
          reason = "threefold repetition";
        }
        else failure({text: "Unknown gameover reason"});

        let playersStatus;
        if (isDraw) {
          playersStatus = "draw";
        }
        else {
          playersStatus =
            idCurr == result.Item.connectionId1
            ? "Player 1 won"
            : "Player 2 won";
        }

        await propagateGameOver(event, body.gameId, playersStatus, reason, body.move);

        if (result.Item.playerId1 != result.Item.playerId2) { // add rating
          let winnerId =
            idCurr == result.Item.connectionId1
            ? result.Item.playerId1
            : result.Item.playerId2;
          params = {
            TableName: process.env.UsersTableName,
            Key: {
              userId: winnerId,
            },
            UpdateExpression: "SET rating = rating + :count",
            ExpressionAttributeValues: {
              ":count": 5,
            },
          };
          await dynamoDbLib.call("update");
        }

        params = {
          TableName: process.env.GamesArchiveTableName,
          Item: {
            gameId: body.gameId,
            user1Id: result.Item.playerId1,
            user2Id: result.Item.playerId2,
            createdAt: result.Item.createdAt,
            winner: idCurr == result.Item.connectionId1 ? 1 : 2,
            notation: chess.pgn(),
          }
        };
        await dynamoDbLib.call("put", params); // put game in archive

        params = {
          TableName: process.env.RoomsTableName,
          Key: {
            gameId: body.gameId,
          }
        };
        await dynamoDbLib.call("delete", params); // delete room

        let connections;
        try { // find all connections with this gameId
          connections = getRoomConnections(body.gameId);
        }
        catch(e) {
          console.log("Error while scanning WebSocketConnections");
          return failure(e);
        }

        for (let i = 0; i < connections.Items.length; ++i) { // delete all connections
          params = {
            TableName: process.env.WebSocketConnectionsTableName,
            Key: {
              connectionId: connections.Items[i].connectionId,
            }
          };
          await dynamoDbLib.call("delete", params);
        }
      }
      else {
        await propagateMove(event, body.gameId, chess.turn() === 'w', body.move);
      }
    }
    else {
      return failure({ status: false, error: "Item not found." });
    }
  }
  catch(e) {
    console.log("error:", e);
    return failure(e);
  }

  return success();
}