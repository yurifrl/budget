{-# LANGUAGE OverloadedStrings #-}

module Database
    ( saveToken
    , retriveToken
    )
where

import Database.Redis
import Data.ByteString (ByteString)
-- import Data.ByteString.UTF8 (fromString)
import Data.Text (Text)

redisConnInfo = defaultConnectInfo { connectHost = "redis" }

saveToken :: ByteString -> ByteString -> ByteString -> ByteString -> IO (Either Reply Status)
saveToken hash login password token = do
    conn <- checkedConnect redisConnInfo
    runRedis conn $
        set (hash <> login) token

retriveToken :: ByteString -> ByteString -> ByteString -> IO (Either Reply (Maybe ByteString))
retriveToken hash login password = do
    conn <- checkedConnect redisConnInfo
    runRedis conn $
        get (hash <> login)
