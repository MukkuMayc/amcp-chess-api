import * as dynamoDbLib from '../libs/dynamodb-lib';
import { success, failure } from '../libs/response-lib';

export async function main(event, context) {
  try {
  console.log('event:', event);
  let body = JSON.parse(event.body);
  // let connectionId = body.connectionId;
  console.log('id', event.pathParameters.id);
  let params = {
    TableName: process.env.RoomsTableName,
    Key: {
      gameId: event.pathParameters.id,
    }
  };
  try {
    const result = await dynamoDbLib.call("get", params);
    if (result.Item) {
      let updateExpression;
      let deleteRoom = false;
      if (result.Item.playerId1 === event.requestContext.identity.cognitoIdentityId) {
         updateExpression = "REMOVE connectionId1, playerId1";
         deleteRoom = true;
      }
      else if (result.Item.playerId2 === event.requestContext.identity.cognitoIdentityId) {
        updateExpression = "REMOVE connectionId2, playerId2";
      }
      else { // just viewer
        return success();
      }

      params = {
        TableName: process.env.RoomsTableName,
        Key: {
          gameId: body.gameId,
        },
        UpdateExpression: updateExpression,
      };
      try {
        deleteRoom
        ? await dynamoDbLib.call("delete", params)
        : await dynamoDbLib.call("update", params);
        return success({ status: false });
      }
      catch(e) {
        console.log('error:', e);
        return failure({ status: false });
      }
    }
    else {
      console.log("Item not found.");
      return success({ status: true, text: "Item not found. The room has been already deleted" });
    }
  } catch (e) {
    console.log('error:', e);
    return failure({ status: false });
  }
  }
  catch(e) {
    console.log("unknown error", e);
  }
}