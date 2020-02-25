{-# OPTIONS_GHC -fno-warn-unused-binds #-}

{-# LANGUAGE DuplicateRecordFields #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE DeriveGeneric #-}
module Budget (run) where

import Types
import QRCode (createQrCode, getId)
import Database (saveToken, retriveToken)

import Control.Lens ((&), (^.), (^?), (.~))
import Data.Aeson (FromJSON, toJSON, Value, decode)
import Data.Aeson.Lens (_String, key)
import Data.ByteString.Lazy (ByteString)
import Data.Complex
import Data.Maybe (fromMaybe)
import Data.Text (Text, unpack, pack)
import Data.Text.Encoding (encodeUtf8)
import Network.Wreq (postWith, getWith, responseBody, Options, defaults, header, Response)
import qualified Data.ByteString.UTF8 as BU
import qualified Data.ByteString.Char8 as BC

hash :: String
hash = "123"
discoveryUrl :: String
discoveryUrl = "https://prod-s0-webapp-proxy.nubank.com.br/api/discovery"
discoveryAppUrl :: String
discoveryAppUrl = "https://prod-s0-webapp-proxy.nubank.com.br/api/app/discovery"

-- | headers
headers :: Options
headers = defaults
  & header "Content-Type" .~ ["application/json"]
  & header "X-Correlation-Id" .~ ["WEB-APP.pewW9"]
  & header "User-Agent" .~ ["lambdaNu Client - https://github.com/yurifrl/lambdaNu"]

-- |
getProxyAppUrl :: String -> IO (Maybe ByteString)
getProxyAppUrl url = do
  res <- getWith headers url
  return $ res ^? responseBody

-- |
getProxyUrl :: String -> IO (Maybe ByteString)
getProxyUrl url = do
  res <- getWith headers url
  return $ res ^? responseBody

-- |
passwordAuth :: String -> String -> String -> IO (Maybe ByteString)
passwordAuth url l p = do
  res <- postWith headers url (toJSON o)
  return $ res ^? responseBody
  where
    o = defaultLoginRequest l p


lift :: String -> String -> String -> IO (Maybe ByteString)
lift url token id = do
  res <- postWith (headers & header "Authorization" .~ [BC.pack ("Bearer " ++ token)]) url (toJSON o)
  return $ res ^? responseBody
  where
    o = defaultLiftRequest id

-- | run
run :: Maybe Text -> Maybe Text -> IO ()
run l p = do
  qrCode <- createQrCode
  eitherProxyAppList <- getProxyAppUrl discoveryAppUrl
  eitherProxyList <- getProxyUrl discoveryUrl
  eitherToken <- retriveToken (BU.fromString hash) (encodeUtf8 (fromMaybe "" l)) (encodeUtf8 (fromMaybe "" p))
  token <- case eitherToken of
    Right res -> case res of
      Just t -> do
        print "Token retrived: "
        return t
      Nothing -> do
        resp <- case eitherProxyList of
          Just loginUrl -> passwordAuth
                            (maybe "" unpack $ loginUrl ^? key "login" . _String)
                            (maybe "" unpack l)
                            (maybe "" unpack p)
        token <- case resp of
          Just resp -> return $ maybe "" unpack $ resp ^? key "access_token" . _String
        return $ BU.fromString token

  ok <- saveToken
          (BU.fromString hash)
          (encodeUtf8 (fromMaybe "" l))
          (encodeUtf8 (fromMaybe "" p))
          token

  print ok
  print token
  print qrCode

  resp <- case eitherProxyAppList of
    Just liftUrl -> lift (maybe "" unpack $ liftUrl ^? key "lift" . _String) (BC.unpack token) (getId qrCode)

  print resp

  undefined
