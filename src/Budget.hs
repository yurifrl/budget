{-# LANGUAGE DeriveGeneric, OverloadedStrings, ScopedTypeVariables, DuplicateRecordFields #-}
{-# OPTIONS_GHC -fno-warn-unused-binds #-}
module Budget where

import Types
import QRCode

import Network.Wreq (postWith, responseBody, Options, defaults, header)
import Data.Aeson (ToJSON, FromJSON, toJSON, Value)
import Data.Text (Text, unpack)
import Data.Complex
import Control.Lens

-- import Control.Monad.IO.Class
-- import Data.Aeson
-- import Network.HTTP.Req

discoveryUrl :: String
discoveryUrl = "https://prod-global-webapp-proxy.nubank.com.br/api/app/discovery"
-- discoveryUrl = "https://prod-s0-webapp-proxy.nubank.com.br/api/discovery"
-- tokenUrl = "https://prod-auth.nubank.com.br/api/token"
-- url = "https://prod-customers.nubank.com.br/api/customers"

instance ToJSON Login
instance FromJSON Login

headers :: Options
headers = defaults & header "Content-Type" .~ ["application/json"]
  & header "X-Correlation-Id" .~ ["WEB-APP.pewW9"]
  & header "User-Agent" .~ ["lambdaNu Client - https://github.com/yurifrl/lambdaNu"]


getQrCode :: IO ()
getQrCode = do
  generate
  

-- login :: Maybe Text -> Maybe Text -> IO ()
-- login l p = do
--   r <- postWith headers discoveryUrl (toJSON Login {
--                            login = maybe "" unpack l,
--                            password = maybe "" unpack p,
--                            grant_type = "password",
--                            client_id = "other.conta",
--                            client_secret = "yQPeLzoHuJzlMMSAjC-LgNUJdUecx8XO"
--                            })
--   print r
--   undefined
--   -- r ^? responseBody . key "json" . nth 2
--   -- liftIO $ print (responseBody r :: Value)
